export function shouldShowAdminNavigation(
  account: string | null | undefined,
  governanceAccount: string | null | undefined,
): boolean {
  return Boolean(
    account &&
      governanceAccount &&
      account.toLowerCase() === governanceAccount.toLowerCase(),
  );
}
