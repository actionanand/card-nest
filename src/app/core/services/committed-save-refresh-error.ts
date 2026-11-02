/** The write committed. Retrying as a new transaction would be unsafe. */
export class CommittedSaveRefreshError extends Error {
  constructor(
    readonly transactionId: string,
    cause: unknown,
    operation: 'saved' | 'deleted' = 'saved',
  ) {
    const committedAction = operation === 'deleted' ? 'Transaction deleted' : 'Transaction saved';
    const retryGuidance =
      operation === 'deleted' ? 'Do not repeat the delete.' : 'Do not enter it again.';
    super(
      `${committedAction}, but the screen could not fully refresh. Retry the refresh; ${retryGuidance}`,
      { cause },
    );
    this.name = 'CommittedSaveRefreshError';
  }
}
