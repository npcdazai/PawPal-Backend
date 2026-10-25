import { ConnectorConfig, DataConnect, OperationOptions, ExecuteOperationResponse } from 'firebase-admin/data-connect';

export const connectorConfig: ConnectorConfig;

export type TimestampString = string;
export type UUIDString = string;
export type Int64String = string;
export type DateString = string;


export interface BankAccount_Key {
  id: UUIDString;
  __typename?: 'BankAccount_Key';
}

export interface CreateBankAccountData {
  bankAccount_insert: BankAccount_Key;
}

export interface CreateBankAccountVariables {
  providerName: string;
  lastFourDigits: string;
}

export interface CreateNotificationData {
  notification_insert: Notification_Key;
}

export interface CreateNotificationVariables {
  message: string;
  userId: UUIDString;
}

export interface CreateTransactionData {
  transaction_insert: Transaction_Key;
}

export interface CreateTransactionVariables {
  amount: number;
  status: string;
  type: string;
  receiverId: UUIDString;
  note?: string | null;
}

export interface CreateUserData {
  user_insert: User_Key;
}

export interface CreateUserVariables {
  username: string;
  email: string;
  phoneNumber: string;
}

export interface CreateWalletData {
  wallet_insert: Wallet_Key;
}

export interface CreateWalletVariables {
  balance: number;
  currency: string;
}

export interface DeleteBankAccountData {
  bankAccount_delete?: BankAccount_Key | null;
}

export interface DeleteBankAccountVariables {
  id: UUIDString;
}

export interface DeleteNotificationData {
  notification_delete?: Notification_Key | null;
}

export interface DeleteNotificationVariables {
  id: UUIDString;
}

export interface DeleteTransactionData {
  transaction_delete?: Transaction_Key | null;
}

export interface DeleteTransactionVariables {
  id: UUIDString;
}

export interface DeleteUserData {
  user_delete?: User_Key | null;
}

export interface DeleteWalletData {
  wallet_delete?: Wallet_Key | null;
}

export interface DeleteWalletVariables {
  id: UUIDString;
}

export interface GetBankAccountData {
  bankAccount?: {
    providerName: string;
    lastFourDigits: string;
  };
}

export interface GetBankAccountVariables {
  id: UUIDString;
}

export interface GetNotificationData {
  notification?: {
    message: string;
    isRead: boolean;
  };
}

export interface GetNotificationVariables {
  id: UUIDString;
}

export interface GetTransactionData {
  transaction?: {
    amount: number;
    status: string;
    type: string;
    note?: string | null;
    timestamp?: TimestampString | null;
  };
}

export interface GetTransactionVariables {
  id: UUIDString;
}

export interface GetUserData {
  user?: {
    username: string;
    email: string;
    phoneNumber: string;
    profileImageUrl?: string | null;
    createdAt?: TimestampString | null;
  };
}

export interface GetWalletData {
  wallet?: {
    balance: number;
    currency: string;
  };
}

export interface GetWalletVariables {
  id: UUIDString;
}

export interface ListAllUsersData {
  users: ({
    username: string;
    profileImageUrl?: string | null;
  })[];
}

export interface ListMyBankAccountsData {
  bankAccounts: ({
    providerName: string;
    lastFourDigits: string;
  })[];
}

export interface ListMyNotificationsData {
  notifications: ({
    message: string;
    isRead: boolean;
  })[];
}

export interface ListMyTransactionsData {
  transactions: ({
    amount: number;
    status: string;
    type: string;
    note?: string | null;
  })[];
}

export interface ListMyWalletsData {
  wallets: ({
    balance: number;
    currency: string;
  })[];
}

export interface MarkNotificationReadData {
  notification_update?: Notification_Key | null;
}

export interface MarkNotificationReadVariables {
  id: UUIDString;
}

export interface Notification_Key {
  id: UUIDString;
  __typename?: 'Notification_Key';
}

export interface Transaction_Key {
  id: UUIDString;
  __typename?: 'Transaction_Key';
}

export interface UpdateBankAccountData {
  bankAccount_update?: BankAccount_Key | null;
}

export interface UpdateBankAccountVariables {
  id: UUIDString;
  providerName?: string | null;
}

export interface UpdateTransactionStatusData {
  transaction_update?: Transaction_Key | null;
}

export interface UpdateTransactionStatusVariables {
  id: UUIDString;
  status: string;
}

export interface UpdateUserData {
  user_update?: User_Key | null;
}

export interface UpdateUserVariables {
  username?: string | null;
  email?: string | null;
  phoneNumber?: string | null;
}

export interface UpdateWalletData {
  wallet_update?: Wallet_Key | null;
}

export interface UpdateWalletVariables {
  id: UUIDString;
  balance?: number | null;
}

export interface User_Key {
  id: UUIDString;
  __typename?: 'User_Key';
}

export interface Wallet_Key {
  id: UUIDString;
  __typename?: 'Wallet_Key';
}

/** Generated Node Admin SDK operation action function for the 'CreateUser' Mutation. Allow users to execute without passing in DataConnect. */
export function createUser(dc: DataConnect, vars: CreateUserVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<CreateUserData>>;
/** Generated Node Admin SDK operation action function for the 'CreateUser' Mutation. Allow users to pass in custom DataConnect instances. */
export function createUser(vars: CreateUserVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<CreateUserData>>;

/** Generated Node Admin SDK operation action function for the 'UpdateUser' Mutation. Allow users to execute without passing in DataConnect. */
export function updateUser(dc: DataConnect, vars?: UpdateUserVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<UpdateUserData>>;
/** Generated Node Admin SDK operation action function for the 'UpdateUser' Mutation. Allow users to pass in custom DataConnect instances. */
export function updateUser(vars?: UpdateUserVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<UpdateUserData>>;

/** Generated Node Admin SDK operation action function for the 'DeleteUser' Mutation. Allow users to execute without passing in DataConnect. */
export function deleteUser(dc: DataConnect, options?: OperationOptions): Promise<ExecuteOperationResponse<DeleteUserData>>;
/** Generated Node Admin SDK operation action function for the 'DeleteUser' Mutation. Allow users to pass in custom DataConnect instances. */
export function deleteUser(options?: OperationOptions): Promise<ExecuteOperationResponse<DeleteUserData>>;

/** Generated Node Admin SDK operation action function for the 'GetUser' Query. Allow users to execute without passing in DataConnect. */
export function getUser(dc: DataConnect, options?: OperationOptions): Promise<ExecuteOperationResponse<GetUserData>>;
/** Generated Node Admin SDK operation action function for the 'GetUser' Query. Allow users to pass in custom DataConnect instances. */
export function getUser(options?: OperationOptions): Promise<ExecuteOperationResponse<GetUserData>>;

/** Generated Node Admin SDK operation action function for the 'ListAllUsers' Query. Allow users to execute without passing in DataConnect. */
export function listAllUsers(dc: DataConnect, options?: OperationOptions): Promise<ExecuteOperationResponse<ListAllUsersData>>;
/** Generated Node Admin SDK operation action function for the 'ListAllUsers' Query. Allow users to pass in custom DataConnect instances. */
export function listAllUsers(options?: OperationOptions): Promise<ExecuteOperationResponse<ListAllUsersData>>;

/** Generated Node Admin SDK operation action function for the 'CreateWallet' Mutation. Allow users to execute without passing in DataConnect. */
export function createWallet(dc: DataConnect, vars: CreateWalletVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<CreateWalletData>>;
/** Generated Node Admin SDK operation action function for the 'CreateWallet' Mutation. Allow users to pass in custom DataConnect instances. */
export function createWallet(vars: CreateWalletVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<CreateWalletData>>;

/** Generated Node Admin SDK operation action function for the 'UpdateWallet' Mutation. Allow users to execute without passing in DataConnect. */
export function updateWallet(dc: DataConnect, vars: UpdateWalletVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<UpdateWalletData>>;
/** Generated Node Admin SDK operation action function for the 'UpdateWallet' Mutation. Allow users to pass in custom DataConnect instances. */
export function updateWallet(vars: UpdateWalletVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<UpdateWalletData>>;

/** Generated Node Admin SDK operation action function for the 'DeleteWallet' Mutation. Allow users to execute without passing in DataConnect. */
export function deleteWallet(dc: DataConnect, vars: DeleteWalletVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<DeleteWalletData>>;
/** Generated Node Admin SDK operation action function for the 'DeleteWallet' Mutation. Allow users to pass in custom DataConnect instances. */
export function deleteWallet(vars: DeleteWalletVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<DeleteWalletData>>;

/** Generated Node Admin SDK operation action function for the 'GetWallet' Query. Allow users to execute without passing in DataConnect. */
export function getWallet(dc: DataConnect, vars: GetWalletVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<GetWalletData>>;
/** Generated Node Admin SDK operation action function for the 'GetWallet' Query. Allow users to pass in custom DataConnect instances. */
export function getWallet(vars: GetWalletVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<GetWalletData>>;

/** Generated Node Admin SDK operation action function for the 'ListMyWallets' Query. Allow users to execute without passing in DataConnect. */
export function listMyWallets(dc: DataConnect, options?: OperationOptions): Promise<ExecuteOperationResponse<ListMyWalletsData>>;
/** Generated Node Admin SDK operation action function for the 'ListMyWallets' Query. Allow users to pass in custom DataConnect instances. */
export function listMyWallets(options?: OperationOptions): Promise<ExecuteOperationResponse<ListMyWalletsData>>;

/** Generated Node Admin SDK operation action function for the 'CreateTransaction' Mutation. Allow users to execute without passing in DataConnect. */
export function createTransaction(dc: DataConnect, vars: CreateTransactionVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<CreateTransactionData>>;
/** Generated Node Admin SDK operation action function for the 'CreateTransaction' Mutation. Allow users to pass in custom DataConnect instances. */
export function createTransaction(vars: CreateTransactionVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<CreateTransactionData>>;

/** Generated Node Admin SDK operation action function for the 'UpdateTransactionStatus' Mutation. Allow users to execute without passing in DataConnect. */
export function updateTransactionStatus(dc: DataConnect, vars: UpdateTransactionStatusVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<UpdateTransactionStatusData>>;
/** Generated Node Admin SDK operation action function for the 'UpdateTransactionStatus' Mutation. Allow users to pass in custom DataConnect instances. */
export function updateTransactionStatus(vars: UpdateTransactionStatusVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<UpdateTransactionStatusData>>;

/** Generated Node Admin SDK operation action function for the 'DeleteTransaction' Mutation. Allow users to execute without passing in DataConnect. */
export function deleteTransaction(dc: DataConnect, vars: DeleteTransactionVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<DeleteTransactionData>>;
/** Generated Node Admin SDK operation action function for the 'DeleteTransaction' Mutation. Allow users to pass in custom DataConnect instances. */
export function deleteTransaction(vars: DeleteTransactionVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<DeleteTransactionData>>;

/** Generated Node Admin SDK operation action function for the 'GetTransaction' Query. Allow users to execute without passing in DataConnect. */
export function getTransaction(dc: DataConnect, vars: GetTransactionVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<GetTransactionData>>;
/** Generated Node Admin SDK operation action function for the 'GetTransaction' Query. Allow users to pass in custom DataConnect instances. */
export function getTransaction(vars: GetTransactionVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<GetTransactionData>>;

/** Generated Node Admin SDK operation action function for the 'ListMyTransactions' Query. Allow users to execute without passing in DataConnect. */
export function listMyTransactions(dc: DataConnect, options?: OperationOptions): Promise<ExecuteOperationResponse<ListMyTransactionsData>>;
/** Generated Node Admin SDK operation action function for the 'ListMyTransactions' Query. Allow users to pass in custom DataConnect instances. */
export function listMyTransactions(options?: OperationOptions): Promise<ExecuteOperationResponse<ListMyTransactionsData>>;

/** Generated Node Admin SDK operation action function for the 'CreateBankAccount' Mutation. Allow users to execute without passing in DataConnect. */
export function createBankAccount(dc: DataConnect, vars: CreateBankAccountVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<CreateBankAccountData>>;
/** Generated Node Admin SDK operation action function for the 'CreateBankAccount' Mutation. Allow users to pass in custom DataConnect instances. */
export function createBankAccount(vars: CreateBankAccountVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<CreateBankAccountData>>;

/** Generated Node Admin SDK operation action function for the 'UpdateBankAccount' Mutation. Allow users to execute without passing in DataConnect. */
export function updateBankAccount(dc: DataConnect, vars: UpdateBankAccountVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<UpdateBankAccountData>>;
/** Generated Node Admin SDK operation action function for the 'UpdateBankAccount' Mutation. Allow users to pass in custom DataConnect instances. */
export function updateBankAccount(vars: UpdateBankAccountVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<UpdateBankAccountData>>;

/** Generated Node Admin SDK operation action function for the 'DeleteBankAccount' Mutation. Allow users to execute without passing in DataConnect. */
export function deleteBankAccount(dc: DataConnect, vars: DeleteBankAccountVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<DeleteBankAccountData>>;
/** Generated Node Admin SDK operation action function for the 'DeleteBankAccount' Mutation. Allow users to pass in custom DataConnect instances. */
export function deleteBankAccount(vars: DeleteBankAccountVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<DeleteBankAccountData>>;

/** Generated Node Admin SDK operation action function for the 'GetBankAccount' Query. Allow users to execute without passing in DataConnect. */
export function getBankAccount(dc: DataConnect, vars: GetBankAccountVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<GetBankAccountData>>;
/** Generated Node Admin SDK operation action function for the 'GetBankAccount' Query. Allow users to pass in custom DataConnect instances. */
export function getBankAccount(vars: GetBankAccountVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<GetBankAccountData>>;

/** Generated Node Admin SDK operation action function for the 'ListMyBankAccounts' Query. Allow users to execute without passing in DataConnect. */
export function listMyBankAccounts(dc: DataConnect, options?: OperationOptions): Promise<ExecuteOperationResponse<ListMyBankAccountsData>>;
/** Generated Node Admin SDK operation action function for the 'ListMyBankAccounts' Query. Allow users to pass in custom DataConnect instances. */
export function listMyBankAccounts(options?: OperationOptions): Promise<ExecuteOperationResponse<ListMyBankAccountsData>>;

/** Generated Node Admin SDK operation action function for the 'CreateNotification' Mutation. Allow users to execute without passing in DataConnect. */
export function createNotification(dc: DataConnect, vars: CreateNotificationVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<CreateNotificationData>>;
/** Generated Node Admin SDK operation action function for the 'CreateNotification' Mutation. Allow users to pass in custom DataConnect instances. */
export function createNotification(vars: CreateNotificationVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<CreateNotificationData>>;

/** Generated Node Admin SDK operation action function for the 'MarkNotificationRead' Mutation. Allow users to execute without passing in DataConnect. */
export function markNotificationRead(dc: DataConnect, vars: MarkNotificationReadVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<MarkNotificationReadData>>;
/** Generated Node Admin SDK operation action function for the 'MarkNotificationRead' Mutation. Allow users to pass in custom DataConnect instances. */
export function markNotificationRead(vars: MarkNotificationReadVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<MarkNotificationReadData>>;

/** Generated Node Admin SDK operation action function for the 'DeleteNotification' Mutation. Allow users to execute without passing in DataConnect. */
export function deleteNotification(dc: DataConnect, vars: DeleteNotificationVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<DeleteNotificationData>>;
/** Generated Node Admin SDK operation action function for the 'DeleteNotification' Mutation. Allow users to pass in custom DataConnect instances. */
export function deleteNotification(vars: DeleteNotificationVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<DeleteNotificationData>>;

/** Generated Node Admin SDK operation action function for the 'GetNotification' Query. Allow users to execute without passing in DataConnect. */
export function getNotification(dc: DataConnect, vars: GetNotificationVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<GetNotificationData>>;
/** Generated Node Admin SDK operation action function for the 'GetNotification' Query. Allow users to pass in custom DataConnect instances. */
export function getNotification(vars: GetNotificationVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<GetNotificationData>>;

/** Generated Node Admin SDK operation action function for the 'ListMyNotifications' Query. Allow users to execute without passing in DataConnect. */
export function listMyNotifications(dc: DataConnect, options?: OperationOptions): Promise<ExecuteOperationResponse<ListMyNotificationsData>>;
/** Generated Node Admin SDK operation action function for the 'ListMyNotifications' Query. Allow users to pass in custom DataConnect instances. */
export function listMyNotifications(options?: OperationOptions): Promise<ExecuteOperationResponse<ListMyNotificationsData>>;

