import WalletClient from "@walletconnect/client";
import { WALLETCONNECT_MULTIVERSX_CHAIN_ID } from "./constants";
import { ErrNotImplemented } from "./errors";
import { ISignableMessage, ITransaction } from "./interface";
import { Logger } from "./logger";
import { UserAddress } from "./userAddress";

interface IClientConnect {
    onClientLogin: () => void;
    onClientLogout(): void;
}

/**
 * @deprecated Use WalletConnectV2Provider, instead.
 */
export class WalletConnectProvider {
    walletConnectBridge: string;
    address: string = "";
    signature: string = "";
    walletConnector: WalletClient | undefined;
    private onClientConnect: IClientConnect;

    constructor(walletConnectBridge: string, onClientConnect: IClientConnect) {
        this.walletConnectBridge = walletConnectBridge;
        this.onClientConnect = onClientConnect;
    }

    /**
     * Initiates wallet connect client.
     */
    async init(): Promise<boolean> {
        this.walletConnector = new WalletClient({
            bridge: this.walletConnectBridge,
        });
        this.walletConnector.on("connect", this.onConnect.bind(this));
        this.walletConnector.on("session_update", this.onDisconnect.bind(this));
        this.walletConnector.on("disconnect", this.onDisconnect.bind(this));

        if (
          this.walletConnector.connected &&
          this.walletConnector.accounts.length
        ) {
            const [account] = this.walletConnector.accounts;
            const [address, signature] = account.split(".");
            await this.loginAccount(address, signature);
        }

        return true;
    }

    /**
     * Returns true if init() was previously called successfully
     */
    isInitialized(): boolean {
        return !!this.walletConnector;
    }

    /**
     * Returns true if provider is connected and a valid account is set
     */
    isConnected(): Promise<boolean> {
        return new Promise((resolve, _) =>
          resolve(
            Boolean(
                this.isInitialized()
                && this.walletConnector?.connected
                && this.address
            )
          )
        );
    }

    async login(): Promise<string> {
        if (!this.walletConnector) {
            await this.init();
        }

        if (this.walletConnector?.connected) {
            await this.walletConnector.killSession();
            Logger.trace("WalletConnect login started but walletConnect not initialized");
            return "";
        }

        await this.walletConnector?.createSession({ chainId: WALLETCONNECT_MULTIVERSX_CHAIN_ID });
        if (!this.walletConnector?.uri) { return ""; }
        return this.walletConnector?.uri;
    }

    /**
     * Mocks a logout request by returning true
     */
    async logout(): Promise<boolean> {
        if (!this.walletConnector) {
            Logger.error("logout: Wallet Connect not initialised, call init() first");
            throw new Error("Wallet Connect not initialised, call init() first");
        }
        if (this.walletConnector.connected) {
            await this.walletConnector?.killSession();
        }
        return true;
    }

    /**
     * Fetches the wallet connect address
     */
    async getAddress(): Promise<string> {
        if (!this.walletConnector) {
            Logger.error("getAddress: Wallet Connect not initialised, call init() first");
            throw new Error("Wallet Connect not initialised, call init() first");
        }
      
        return this.address;
    }

    /**
     * Fetches the wallet connect signature
     */
    async getSignature(): Promise<string> {
        if (!this.walletConnector) {
            Logger.error("getSignature: Wallet Connect not initialised, call init() first");
            throw new Error("Wallet Connect not initialised, call init() first");
        }
        
        return this.signature;
    }

    async signMessage<T extends ISignableMessage>(_: T): Promise<T> {
        throw new ErrNotImplemented();
    }

    /**
     * Signs a transaction and returns it
     * @param transaction
     */
    async signTransaction<T extends ITransaction>(transaction: T): Promise<T> {
        if (!this.walletConnector) {
            Logger.error("signTransaction: Wallet Connect not initialised, call init() first");
            throw new Error("Wallet Connect not initialised, call init() first");
        }

        const address = await this.getAddress();
        const sig = await this.walletConnector.sendCustomRequest({
            method: "erd_sign",
            params: this.prepareWalletConnectMessage(transaction, address)
        });
        if (!sig || !sig.signature) {
            Logger.error("signTransaction: Wallet Connect could not sign the transaction");
            throw new Error("Wallet Connect could not sign the transaction");
        }

        transaction.applySignature(Buffer.from(sig.signature, "hex"));
        return transaction;
    }

    /**
     * Signs an array of transactions and returns it
     * @param transactions
     */
    async signTransactions<T extends ITransaction>(transactions: T[]): Promise<T[]> {
        if(transactions.length === 1) {
            const signedTransaction = await this.signTransaction(transactions[0]);
            return [signedTransaction];
        }

        if (!this.walletConnector) {
            Logger.error("signTransactions: Wallet Connect not initialised, call init() first");
            throw new Error("Wallet Connect not initialised, call init() first");
        }

        const address = await this.getAddress();
        const params = transactions.map((transaction) => this.prepareWalletConnectMessage(transaction, address));
        const signatures: { signature: string }[] | { signature: string } = await this.walletConnector.sendCustomRequest({
            method: "erd_batch_sign",
            params
        });
        if (!signatures || !Array.isArray(signatures)) {
            Logger.error("signTransactions: Wallet Connect could not sign the transactions");
            throw new Error("Wallet Connect could not sign the transactions");
        }

        if (transactions.length !== signatures.length) {
            Logger.error("signTransactions: Wallet Connect could not sign the transactions. Invalid signatures.");
            throw new Error("Wallet Connect could not sign the transactions. Invalid signatures.");
        }

        for (const [index, transaction] of transactions.entries()) {
            transaction.applySignature(Buffer.from(signatures[index].signature, "hex"));
        }

        return transactions;
    }

    /**
     * Sends a custom method and params and returns the response object
     */
    async sendCustomMessage({
        method,
        params,
    }: {
        method: string;
        params: any;
    }): Promise<any> {
        if (!this.walletConnector) {
            Logger.error(
                "sendCustomMessage: Wallet Connect not initialised, call init() first"
            );
            throw new Error("Wallet Connect not initialised, call init() first");
        }
        const customMessageResponse = await this.walletConnector.sendCustomRequest({
            method,
            params,
        });

        if (!customMessageResponse) {
            Logger.error(
                "sendCustomMessage: Wallet Connect could not send the message"
            );
            throw new Error("Wallet Connect could not send the message");
        }

        return customMessageResponse;
    }

    private async onConnect(error: any, { params }: any) {
        if (error) {
            throw error;
        }
        if (!params || !params[0]) {
            Logger.error("Wallet Connect missing payload");
            throw new Error("missing payload");
        }
        const {
            accounts: [account],
        } = params[0];

        const [address, signature] = account.split(".");
        await this.loginAccount(address, signature);
    }

    private async onDisconnect(error: any) {
        if (error) {
            throw error;
        }
        this.onClientConnect.onClientLogout();
    }

    private async loginAccount(address: string, signature?: string) {
        if (this.addressIsValid(address)) {
            this.address = address;
            if (signature) {
                this.signature = signature;
            }
            this.onClientConnect.onClientLogin();
            return;
        }

        Logger.error(`Wallet Connect invalid address ${address}`);
        if (this.walletConnector?.connected) {
            await this.walletConnector?.killSession();
        }
    }

    private prepareWalletConnectMessage(transaction: ITransaction, address: string): any {
        return {
            nonce: transaction.getNonce().valueOf(),
            from: address,
            to: transaction.getReceiver().toString(),
            amount: transaction.getValue().toString(),
            gasPrice: transaction
                .getGasPrice()
                .valueOf()
                .toString(),
            gasLimit: transaction
                .getGasLimit()
                .valueOf()
                .toString(),
            data: Buffer.from(
                transaction
                    .getData()
                    .toString()
                    .trim()
            ).toString(),
            chainId: transaction.getChainID().valueOf(),
            version: transaction.getVersion().valueOf(),
        };
    }

    private addressIsValid(destinationAddress: string): boolean {
        try {
            const addr = UserAddress.fromBech32(destinationAddress);
            return !!addr;
        } catch {
            return false;
        }
    }
}
