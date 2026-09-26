/** DSH 0.1.7 resolves refused writes to false; older settings scopes resolve to void. */
export async function writeSetting(
  scope: { set(field: string, value: unknown): Promise<boolean | void> },
  field: string,
  value: unknown,
  rejectedMessage: string,
): Promise<void> {
  if (await scope.set(field, value) === false) throw new Error(rejectedMessage)
}
