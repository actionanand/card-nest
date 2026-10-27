/** The write committed. Retrying as a new transaction would be unsafe. */
export class CommittedSaveRefreshError extends Error {
  constructor(
    readonly transactionId: string,
    cause: unknown,
  ) {
    super(
      'Transaction saved, but the screen could not fully refresh. Reopen the activity list; do not enter it again.',
      { cause },
    );
    this.name = 'CommittedSaveRefreshError';
  }
}
