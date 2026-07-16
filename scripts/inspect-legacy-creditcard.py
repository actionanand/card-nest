import datetime
import json
import sqlite3
import sys


sys.stdout.reconfigure(encoding="utf-8")

path = sys.argv[1]
connection = sqlite3.connect(f"file:{path.replace('\\', '/')}?mode=ro", uri=True)
connection.row_factory = sqlite3.Row

tables = [
    row["name"]
    for row in connection.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    )
]
print("TABLES")
for table in tables:
    count = connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
    columns = [dict(row) for row in connection.execute(f"PRAGMA table_info({table})")]
    print(
        json.dumps(
            {
                "table": table,
                "rows": count,
                "columns": [
                    {"name": column["name"], "type": column["type"]}
                    for column in columns
                ],
            }
        )
    )

print("TX_SUMMARY")
summary = connection.execute(
    """
    SELECT COUNT(*) AS count,
           MIN(transactiondate) AS min_date,
           MAX(transactiondate) AS max_date,
           MIN(transactionamount) AS min_amount,
           MAX(transactionamount) AS max_amount,
           SUM(transactionamount) AS total_amount,
           SUM(CASE WHEN imagepath IS NOT NULL AND TRIM(imagepath) <> '' THEN 1 ELSE 0 END) AS images,
           SUM(CASE WHEN transactionnotes IS NOT NULL AND TRIM(transactionnotes) <> '' THEN 1 ELSE 0 END) AS notes
    FROM credit_card_transaction
    """
).fetchone()
print(json.dumps(dict(summary)))

print("DATE_INTERPRETATION")
for value in (summary["min_date"], summary["max_date"]):
    divisor = 1000 if value and value > 100_000_000_000 else 1
    converted = datetime.datetime.fromtimestamp(
        value / divisor, datetime.timezone.utc
    ).isoformat()
    print(json.dumps({"raw": value, "utc": converted}))

print("CATEGORIES")
for row in connection.execute(
    """
    SELECT category._id,
           category.categoryname,
           COUNT(transaction_row._id) AS transactions
    FROM credit_card_category category
    LEFT JOIN credit_card_transaction transaction_row
      ON transaction_row.categoryid = category._id
    GROUP BY category._id, category.categoryname
    ORDER BY category.categoryorder, category._id
    """
):
    print(json.dumps(dict(row), ensure_ascii=False))

print("QUALITY")
quality_queries = {
    "missing_card": """
        SELECT COUNT(*) FROM credit_card_transaction transaction_row
        LEFT JOIN credit_card card ON card._id = transaction_row.creditcardid
        WHERE card._id IS NULL
    """,
    "missing_category": """
        SELECT COUNT(*) FROM credit_card_transaction transaction_row
        LEFT JOIN credit_card_category category ON category._id = transaction_row.categoryid
        WHERE category._id IS NULL
    """,
    "duplicate_transaction_ids": """
        SELECT COUNT(*) FROM (
          SELECT _id FROM credit_card_transaction GROUP BY _id HAVING COUNT(*) > 1
        )
    """,
    "recurring_rows": "SELECT COUNT(*) FROM recurring_transaction",
}
for label, query in quality_queries.items():
    print(json.dumps({label: connection.execute(query).fetchone()[0]}))

print("CATEGORY_SIGNS")
for row in connection.execute(
    """
    SELECT COALESCE(category.categoryname, '[missing category]') AS category,
           COUNT(*) AS transactions,
           SUM(CASE WHEN transaction_row.transactionamount < 0 THEN 1 ELSE 0 END) AS negative,
           SUM(CASE WHEN transaction_row.transactionamount = 0 THEN 1 ELSE 0 END) AS zero,
           SUM(CASE WHEN transaction_row.transactionamount > 0 THEN 1 ELSE 0 END) AS positive,
           MIN(transaction_row.transactionamount) AS min_amount,
           MAX(transaction_row.transactionamount) AS max_amount
    FROM credit_card_transaction transaction_row
    LEFT JOIN credit_card_category category
      ON category._id = transaction_row.categoryid
    GROUP BY transaction_row.categoryid, category.categoryname
    ORDER BY transactions DESC
    """
):
    print(json.dumps(dict(row), ensure_ascii=False))

print("CARD_NUMBER_SHAPES")
for row in connection.execute(
    """
    SELECT LENGTH(COALESCE(cardnumber, '')) AS digits, COUNT(*) AS cards
    FROM credit_card
    GROUP BY LENGTH(COALESCE(cardnumber, ''))
    ORDER BY digits
    """
):
    print(json.dumps(dict(row)))

print("MISSING_CATEGORY_IDS")
for row in connection.execute(
    """
    SELECT transaction_row.categoryid,
           COUNT(*) AS transactions,
           SUM(CASE WHEN transaction_row.transactionamount < 0 THEN 1 ELSE 0 END) AS negative,
           SUM(CASE WHEN transaction_row.transactionamount > 0 THEN 1 ELSE 0 END) AS positive
    FROM credit_card_transaction transaction_row
    LEFT JOIN credit_card_category category
      ON category._id = transaction_row.categoryid
    WHERE category._id IS NULL
    GROUP BY transaction_row.categoryid
    ORDER BY transactions DESC
    """
):
    print(json.dumps(dict(row)))

print("CREDIT_SAMPLES")
for row in connection.execute(
    """
    SELECT COALESCE(category.categoryname, '[missing category]') AS category,
           transaction_row.transactionamount AS amount,
           SUBSTR(COALESCE(transaction_row.transactionnotes, ''), 1, 80) AS note
    FROM credit_card_transaction transaction_row
    LEFT JOIN credit_card_category category
      ON category._id = transaction_row.categoryid
    WHERE transaction_row.transactionamount < 0
    ORDER BY transaction_row.transactiondate DESC
    LIMIT 40
    """
):
    print(json.dumps(dict(row), ensure_ascii=False))

print("MISSING_POSITIVE_SAMPLES")
for row in connection.execute(
    """
    SELECT transactionamount AS amount,
           SUBSTR(COALESCE(transactionnotes, ''), 1, 80) AS note,
           ischecked
    FROM credit_card_transaction
    WHERE categoryid = -1 AND transactionamount > 0
    ORDER BY transactiondate DESC
    LIMIT 30
    """
):
    print(json.dumps(dict(row), ensure_ascii=False))

connection.close()
