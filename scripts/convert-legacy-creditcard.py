import argparse
import base64
import datetime
import gzip
import hashlib
import json
import os
import re
import sqlite3
import unicodedata
import uuid

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


BACKUP_TABLES = (
    "app_preferences",
    "categories",
    "credit_cards",
    "card_relationship_groups",
    "card_relationship_members",
    "card_benefits",
    "card_important_links",
    "card_secrets",
    "card_transactions",
    "transaction_links",
    "transaction_split_groups",
    "transaction_split_members",
    "statements",
    "recurring_rules",
    "attachments",
    "emi_plans",
    "emi_installments",
    "monthly_income",
    "category_limits",
)

COLOURS = (
    "#de7d68",
    "#e0a860",
    "#5a9d90",
    "#9075b5",
    "#4e87c7",
    "#c8a43b",
    "#d56a7b",
    "#65758b",
)

ICON_KEYWORDS = {
    "dining": "restaurant",
    "pastry": "popcorn",
    "meat": "shopping_basket",
    "veg": "shopping_basket",
    "groceries": "shopping_cart",
    "shopping": "shopping_bag",
    "household": "home",
    "fuel": "local_gas_station",
    "online": "globe_check",
    "kids": "baby",
    "fashion": "shopping_bag",
    "utility": "receipt",
    "mobile": "smartphone",
    "travel": "plane",
    "healthcare": "health_and_safety",
    "electronics": "monitor",
    "cinema": "film",
    "entertainment": "popcorn",
    "electricity": "bolt",
    "religious": "landmark",
    "insurance": "shield_check",
    "emi": "landmark",
    "education": "book_open",
    "jewels": "gem",
    "lpg": "flame",
    "loans": "banknote_arrow_up",
    "payment": "payments",
    "refund": "banknote_arrow_down",
    "voucher": "tag",
    "accommodation": "bed",
}

NETWORKS = {
    "visa": "VISA",
    "mastercard": "MASTERCARD",
    "rupay": "RUPAY",
    "american express": "AMERICAN_EXPRESS",
    "discover card": "DISCOVER",
    "jcb": "JCB",
    "diners club": "DINERS_CLUB",
    "unionpay": "UNIONPAY",
}

CURRENT_CATEGORIES = (
    ("groceries", "Groceries", "shopping_basket", "#e0a860", "BOTH"),
    ("dining", "Dining", "restaurant", "#de7d68", "BOTH"),
    ("fuel", "Fuel", "local_gas_station", "#5a9d90", "BOTH"),
    ("shopping", "Shopping", "shopping_bag", "#9075b5", "BOTH"),
    ("travel", "Travel", "flight", "#4e87c7", "BOTH"),
    ("utilities", "Utilities", "bolt", "#c8a43b", "BOTH"),
    ("healthcare", "Healthcare", "health_and_safety", "#d56a7b", "BOTH"),
    ("subscription", "Subscription", "subscriptions", "#65758b", "BOTH"),
    ("payment", "Card Payment", "payments", "#4e9d73", "CREDIT"),
    (
        "contra-expenses",
        "Contra-expenses",
        "banknote_arrow_down",
        "#4e9d73",
        "CREDIT",
    ),
    ("other", "Other", "category", "#7a8797", "BOTH"),
)

CATEGORY_TARGETS = {
    "dining": "dining",
    "pastry and snacks": "dining",
    "meat fish and milk products": "groceries",
    "veg and fruits": "groceries",
    "groceries": "groceries",
    "shopping and retail": "shopping",
    "household": "shopping",
    "online": "shopping",
    "fashion": "shopping",
    "electronics": "shopping",
    "jewels": "shopping",
    "voucher": "shopping",
    "fuel": "fuel",
    "utility bill": "utilities",
    "mobile recharge": "utilities",
    "electricity": "utilities",
    "lpg and gas": "utilities",
    "travel": "travel",
    "accommodation": "travel",
    "healthcare": "healthcare",
    "payment": "payment",
    "refund and cashback": "contra-expenses",
    "other expenses": "other",
    "wifey cc": "other",
}


def parse_args():
    parser = argparse.ArgumentParser(
        description="Convert a legacy .creditcard SQLite backup to an encrypted CardNest backup."
    )
    parser.add_argument("source")
    parser.add_argument("destination")
    parser.add_argument("--passphrase", required=True)
    return parser.parse_args()


def as_int(value, fallback=None):
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return fallback


def iso_date(epoch_milliseconds):
    return datetime.datetime.fromtimestamp(
        int(epoch_milliseconds) / 1000, datetime.timezone.utc
    ).date().isoformat()


def icon_for(name):
    normalized = name.casefold()
    return next(
        (icon for keyword, icon in ICON_KEYWORDS.items() if keyword in normalized),
        "category",
    )


def clean_category_name(value):
    without_symbols = "".join(
        character
        for character in unicodedata.normalize("NFKC", str(value or ""))
        if unicodedata.category(character) not in {"So", "Sk"}
        and character not in {"\ufe0f", "\u200d"}
    )
    return re.sub(r"\s+", " ", without_symbols).strip(" -")


def normalized_category_name(value):
    cleaned = clean_category_name(value).casefold().replace("&", " and ")
    return re.sub(r"[^a-z0-9]+", " ", cleaned).strip()


def category_target(value):
    cleaned = clean_category_name(value)
    normalized = normalized_category_name(cleaned)
    current_id = CATEGORY_TARGETS.get(normalized)
    if current_id:
        return current_id, None
    if normalized in {"cinema", "entertainment"}:
        return "legacy-category-entertainment", "Entertainment"
    slug = re.sub(r"[^a-z0-9]+", "-", normalized).strip("-") or "uncategorized"
    return f"legacy-category-{slug}", cleaned or "Legacy uncategorized"


def issuer_for(card_name):
    words = str(card_name or "Legacy card").strip().split()
    return words[0] if words else "Legacy issuer"


def network_for(card_type):
    normalized = str(card_type or "").strip().casefold()
    return NETWORKS.get(normalized, "OTHER")


def cleaned_last_digits(value):
    digits = re.sub(r"\D", "", str(value or ""))[-5:]
    if len(digits) not in (4, 5):
        return "0000"
    return digits


def card_notes(row):
    details = []
    for label, key in (
        ("Description", "description"),
        ("Notes", "notes"),
        ("Waiver condition", "waivercondition"),
    ):
        value = str(row[key] or "").strip()
        if value:
            details.append(f"{label}: {value}")
    annual_fee = as_int(row["annualfee"], 0) or 0
    if annual_fee:
        details.append(f"Legacy annual fee: INR {annual_fee / 100:.2f}")
    interest_rate = as_int(row["interestrate"], 0) or 0
    if interest_rate:
        details.append(f"Legacy interest rate value: {interest_rate}")
    return "\n".join(details) or None


def make_card(row, earliest_date):
    card_id = f"legacy-card-{row['_id']}"
    nickname = str(row["cardname"] or f"Legacy card {row['_id']}").strip()
    network = network_for(row["cardtype"])
    statement_day = as_int(row["statementdate"], 1) or 1
    payment_due_day = as_int(row["duedate"], 1) or 1
    expiry_month = as_int(row["expirymonth"])
    expiry_year = as_int(row["expiryyear"])
    if expiry_year is not None and expiry_year < 100:
        expiry_year += 2000
    archived = bool(row["isarchived"])
    notes = card_notes(row)
    hotline = str(row["hotline"] or "").strip()
    payload = {
        "id": card_id,
        "nickname": nickname,
        "issuerName": issuer_for(nickname),
        "lastDigits": cleaned_last_digits(row["cardnumber"]),
        "network": network,
        "theme": "indigo" if int(row["_id"]) % 2 else "teal",
        "statementDay": min(31, max(1, statement_day)),
        "dueDateMode": "FIXED_DAY",
        "paymentDueDay": min(31, max(1, payment_due_day)),
        "adjustDueDateOnWeekend": True,
        "currencyCode": "INR",
        "openingBalanceMinor": 0,
        "remindToSettle": not bool(row["ignoreduedate"]),
        "annualFeeEnabled": False,
        "emergencyPhones": [hotline] if hotline else [],
        "supportEmails": [],
        "archived": archived,
        "createdAt": earliest_date,
        "updatedAt": earliest_date,
        "benefits": [],
        "importantLinks": [],
    }
    if network == "OTHER" and str(row["cardtype"] or "").strip():
        payload["customNetwork"] = str(row["cardtype"]).strip()
    if expiry_month is not None and 1 <= expiry_month <= 12:
        payload["expiryMonth"] = expiry_month
    if expiry_year is not None and 2000 <= expiry_year <= 2200:
        payload["expiryYear"] = expiry_year
    credit_limit = as_int(row["creditlimit"])
    if credit_limit is not None and credit_limit >= 0:
        payload["creditLimitMinor"] = credit_limit
    if notes:
        payload["notes"] = notes
    return {
        "id": card_id,
        "nickname": nickname,
        "issuer_name": payload["issuerName"],
        "last_digits": payload["lastDigits"],
        "encrypted_full_number": None,
        "network": network,
        "payload": json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        "archived": 1 if archived else 0,
        "created_at": earliest_date,
        "updated_at": earliest_date,
    }


def make_category(category_id, name, index):
    return {
        "id": category_id,
        "name": name,
        "icon": icon_for(name),
        "colour": COLOURS[index % len(COLOURS)],
        "applies_to": "BOTH",
        "archived": 0,
    }


def make_transaction(row, category_names, category_ids):
    raw_amount = int(row["transactionamount"])
    date = iso_date(row["transactiondate"])
    note = str(row["transactionnotes"] or "").strip()
    category_name = category_names.get(row["categoryid"], "")
    is_credit = raw_amount < 0
    if row["categoryid"] == -1:
        category_id = "legacy-category-payment" if is_credit else "legacy-category-uncategorized"
    else:
        category_id = category_ids[row["categoryid"]]
    if is_credit:
        transaction_type = (
            "PAYMENT"
            if "payment" in category_name.casefold()
            or "settle due amount" in note.casefold()
            or row["categoryid"] == -1
            else "REFUND"
        )
    else:
        transaction_type = "PURCHASE"
    transaction_id = f"legacy-tx-{row['_id']}"
    timestamp = f"{date}T00:00:00.000Z"
    payload = {
        "id": transaction_id,
        "cardId": f"legacy-card-{row['creditcardid']}",
        "type": transaction_type,
        "amountMinor": abs(raw_amount),
        "currencyCode": "INR",
        "transactionDate": date,
        "categoryId": category_id,
        "attachmentIds": [],
        "createdAt": timestamp,
        "updatedAt": timestamp,
    }
    if note:
        payload["merchant"] = note.splitlines()[0][:160]
        payload["notes"] = note
    return {
        "id": transaction_id,
        "card_id": payload["cardId"],
        "category_id": category_id,
        "type": transaction_type,
        "amount_minor": abs(raw_amount),
        "currency_code": "INR",
        "transaction_date": date,
        "payload": json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        "created_at": timestamp,
        "updated_at": timestamp,
    }


def convert(source, destination, passphrase):
    if len(passphrase) < 8:
        raise ValueError("The CardNest backup passphrase must contain at least 8 characters.")
    connection = sqlite3.connect(f"file:{source.replace('\\', '/')}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    tables = {
        row["name"]
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        )
    }
    required = {"credit_card", "credit_card_category", "credit_card_transaction"}
    if not required.issubset(tables):
        raise ValueError("This is not a supported legacy .creditcard database.")

    date_row = connection.execute(
        "SELECT MIN(transactiondate) AS earliest FROM credit_card_transaction"
    ).fetchone()
    earliest_date = iso_date(date_row["earliest"]) if date_row["earliest"] else "2022-01-01"
    categories_source = list(
        connection.execute("SELECT * FROM credit_card_category ORDER BY categoryorder, _id")
    )
    category_names = {
        row["_id"]: str(row["categoryname"] or "") for row in categories_source
    }
    categories = [
        {
            "id": category_id,
            "name": name,
            "icon": icon,
            "colour": colour,
            "applies_to": applies_to,
            "archived": 0,
        }
        for category_id, name, icon, colour, applies_to in CURRENT_CATEGORIES
    ]
    category_ids = {}
    custom_categories = {}
    for row in categories_source:
        target_id, custom_name = category_target(row["categoryname"])
        category_ids[row["_id"]] = target_id
        if custom_name:
            custom_categories[target_id] = custom_name
    categories.extend(
        make_category(category_id, name, index)
        for index, (category_id, name) in enumerate(sorted(custom_categories.items()))
    )
    categories.extend(
        (
            {
                "id": "legacy-category-payment",
                "name": "Legacy card payment",
                "icon": "payments",
                "colour": "#4e9d73",
                "applies_to": "CREDIT",
                "archived": 0,
            },
            {
                "id": "legacy-category-uncategorized",
                "name": "Legacy uncategorized",
                "icon": "category",
                "colour": "#7a8797",
                "applies_to": "BOTH",
                "archived": 0,
            },
        )
    )
    cards = [
        make_card(row, earliest_date)
        for row in connection.execute("SELECT * FROM credit_card ORDER BY _id")
    ]
    transactions = [
        make_transaction(row, category_names, category_ids)
        for row in connection.execute("SELECT * FROM credit_card_transaction ORDER BY _id")
    ]
    connection.close()

    rows_by_table = {table: [] for table in BACKUP_TABLES}
    rows_by_table["categories"] = categories
    rows_by_table["credit_cards"] = cards
    rows_by_table["card_transactions"] = transactions
    portable = {
        "format": "cardnest-portable-sqlite",
        "version": 1,
        "databaseVersion": 5,
        "tables": [
            {"name": table, "rows": rows_by_table[table]} for table in BACKUP_TABLES
        ],
    }
    plaintext = json.dumps(portable, ensure_ascii=False, separators=(",", ":")).encode()
    compressed = gzip.compress(plaintext, compresslevel=9, mtime=0)
    salt = os.urandom(16)
    iv = os.urandom(12)
    iterations = 310_000
    key = hashlib.pbkdf2_hmac("sha256", passphrase.encode(), salt, iterations, dklen=32)
    encrypted = AESGCM(key).encrypt(iv, compressed, None)
    envelope = {
        "format": "cardnest-encrypted-backup",
        "version": 2,
        "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
        "compression": "gzip",
        "kdf": {
            "algorithm": "PBKDF2-SHA256",
            "iterations": iterations,
            "salt": base64.b64encode(salt).decode(),
        },
        "cipher": {
            "algorithm": "AES-GCM",
            "iv": base64.b64encode(iv).decode(),
            "data": base64.b64encode(encrypted).decode(),
        },
    }
    with open(destination, "w", encoding="utf-8", newline="") as output:
        json.dump(envelope, output, separators=(",", ":"))
    print(
        json.dumps(
            {
                "destination": destination,
                "cards": len(cards),
                "categories": len(categories),
                "transactions": len(transactions),
                "earliestDate": min(row["transaction_date"] for row in transactions),
                "latestDate": max(row["transaction_date"] for row in transactions),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    arguments = parse_args()
    convert(arguments.source, arguments.destination, arguments.passphrase)
