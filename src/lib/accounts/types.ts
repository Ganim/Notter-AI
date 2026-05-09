export interface AccountSummary {
  id: string;
  email: string;
  displayName: string | null;
  addedAt: string;
}

export interface AccountIndex {
  accounts: AccountSummary[];
}

export interface ActiveAccountPointer {
  accountId: string | null;
}
