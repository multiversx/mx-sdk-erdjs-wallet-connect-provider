import Client from "@walletconnect/sign-client";
import {
  PairingTypes,
  SessionTypes,
  EngineTypes,
  SignClientTypes,
} from "@walletconnect/types";
import { getSdkError } from "@walletconnect/utils";
import { ISignableMessage, ITransaction } from "./interface";
import {
  WALLETCONNECT_MULTIVERSX_NAMESPACE,
  WALLETCONNECT_OLD_NAMESPACE,
  WALLETCONNECT_OLD_METHOD_PREFIX,
} from "./constants";
import { Operation, OldOperation } from "./operation";
import { Logger } from "./logger";
import { Signature, Address } from "./primitives";
import { WalletConnectV2ProviderErrorMessagesEnum } from "./errors";
import { UserAddress } from "./userAddress";

interface SessionEventTypes {
  event: {
    name: string;
    data: any;
  };
  chainId: string;
}

interface IClientConnect {
  onClientLogin: () => void;
  onClientLogout(): void;
  onClientEvent: (event: SessionEventTypes["event"]) => void;
}

export {
  PairingTypes,
  SessionTypes,
  SessionEventTypes,
  EngineTypes,
  WalletConnectV2ProviderErrorMessagesEnum,
};

export class WalletConnectV2Provider {
  walletConnectV2Relay: string;
  walletConnectV2ProjectId: string;
  chainId: string = "";
  address: string = "";
  signature: string = "";
  namespace: string = WALLETCONNECT_OLD_NAMESPACE;
  isInitializing: boolean = false;
  walletConnector: Client | undefined;
  session: SessionTypes.Struct | undefined;
  pairings: PairingTypes.Struct[] | undefined;
  events: SessionTypes.Namespace["events"] = [];
  methods: string[] = [];
  options: Omit<SignClientTypes.Options, "relayUrl" | "projectId"> | undefined =
    {};

  private onClientConnect: IClientConnect;

  constructor(
    onClientConnect: IClientConnect,
    chainId: string,
    walletConnectV2Relay: string,
    walletConnectV2ProjectId: string,
    options?: Omit<SignClientTypes.Options, "relayUrl" | "projectId">
  ) {
    this.onClientConnect = onClientConnect;
    this.chainId = chainId;
    this.walletConnectV2Relay = walletConnectV2Relay;
    this.walletConnectV2ProjectId = walletConnectV2ProjectId;
    this.options = options;
  }

  reset() {
    this.address = "";
    this.signature = "";
    this.namespace = WALLETCONNECT_OLD_NAMESPACE;
    this.session = undefined;
  }

  /**
   * Initiates WalletConnect client.
   */
  async init(): Promise<boolean> {
    if (this.isInitialized()) {
      return this.isInitialized();
    } else {
      try {
        this.reset();
        const client = await Client.init({
          relayUrl: this.walletConnectV2Relay,
          projectId: this.walletConnectV2ProjectId,
          ...this.options,
        });

        this.walletConnector = client;
        await this.subscribeToEvents(client);
        await this.checkPersistedState(client);
      } catch (error) {
        throw new Error(WalletConnectV2ProviderErrorMessagesEnum.unableToInit);
      } finally {
        this.isInitializing = false;
        return this.isInitialized();
      }
    }
  }

  /**
   * Returns true if init() was previously called successfully
   */
  isInitialized(): boolean {
    return !!this.walletConnector && !this.isInitializing;
  }

  /**
   * Returns true if provider is initialized and a valid session is set
   */
  isConnected(): Promise<boolean> {
    return new Promise((resolve, _) =>
      resolve(
        Boolean(this.isInitialized() && typeof this.session !== "undefined")
      )
    );
  }

  async connect(options?: {
    topic?: string;
    events?: SessionTypes.Namespace["events"];
    methods?: string[];
  }): Promise<{
    uri?: string;
    approval: () => Promise<SessionTypes.Struct>;
  }> {
    if (typeof this.walletConnector === "undefined") {
      await this.init();
    }

    if (typeof this.walletConnector === "undefined") {
      throw new Error(WalletConnectV2ProviderErrorMessagesEnum.notInitialized);
    }

    const methods = [
      ...Object.values(Operation),
      ...(options?.methods
        ? options.methods.filter((method) =>
            method.startsWith(WALLETCONNECT_MULTIVERSX_NAMESPACE)
          )
        : []),
    ];
    const oldMethods = [
      ...Object.values(OldOperation),
      ...(options?.methods
        ? options.methods.filter((method) =>
            method.startsWith(WALLETCONNECT_OLD_METHOD_PREFIX)
          )
        : []),
    ];

    // Temporarily accept requests from both multiversx and elrond namespaces
    const chains = [`${WALLETCONNECT_MULTIVERSX_NAMESPACE}:${this.chainId}`];
    const oldChains = [`${WALLETCONNECT_OLD_NAMESPACE}:${this.chainId}`];
    const events = options?.events ?? [];
    try {
      const response = await this.walletConnector.connect({
        pairingTopic: options?.topic,
        requiredNamespaces: {
          [WALLETCONNECT_OLD_NAMESPACE]: {
            methods: oldMethods,
            chains: oldChains,
            events,
          },
        },
        optionalNamespaces: {
          [WALLETCONNECT_MULTIVERSX_NAMESPACE]: {
            methods,
            chains,
            events,
          },
        },
      });
      this.events = events;
      this.methods = methods;

      return response;
    } catch (error) {
      if (options?.topic) {
        await this.logout({ topic: options.topic });
        Logger.error(
          WalletConnectV2ProviderErrorMessagesEnum.unableToConnectExisting
        );
        throw new Error(
          WalletConnectV2ProviderErrorMessagesEnum.unableToConnectExisting
        );
      } else {
        Logger.error(WalletConnectV2ProviderErrorMessagesEnum.unableToConnect);
        throw new Error(
          WalletConnectV2ProviderErrorMessagesEnum.unableToConnect
        );
      }
    }
  }

  async login(options?: {
    approval?: () => Promise<SessionTypes.Struct>;
    token?: string;
  }): Promise<string> {
    this.isInitializing = true;
    if (typeof this.walletConnector === "undefined") {
      await this.connect();
    }

    if (typeof this.walletConnector === "undefined") {
      throw new Error(WalletConnectV2ProviderErrorMessagesEnum.notInitialized);
    }

    if (typeof this.session !== "undefined") {
      await this.logout();
    }

    try {
      if (options && options.approval) {
        const session = await options.approval();

        if (session?.namespaces?.[WALLETCONNECT_OLD_NAMESPACE]) {
          this.namespace = WALLETCONNECT_OLD_NAMESPACE;
        }

        if (session?.namespaces?.[WALLETCONNECT_MULTIVERSX_NAMESPACE]) {
          this.namespace = WALLETCONNECT_MULTIVERSX_NAMESPACE;
        }

        if (options.token) {
          const address = this.getAddressFromSession(session);
          const { signature }: { signature: string } =
            await this.walletConnector.request({
              chainId: `${this.namespace}:${this.chainId}`,
              topic: session.topic,
              request: {
                method:
                  this.namespace === WALLETCONNECT_MULTIVERSX_NAMESPACE
                    ? Operation.SIGN_LOGIN_TOKEN
                    : OldOperation.SIGN_LOGIN_TOKEN,
                params: {
                  token: options.token,
                  address,
                },
              },
            });

          if (!signature) {
            Logger.error(
              WalletConnectV2ProviderErrorMessagesEnum.unableToSignLoginToken
            );
            throw new Error(
              WalletConnectV2ProviderErrorMessagesEnum.unableToSignLoginToken
            );
          }

          return await this.onSessionConnected({
            session,
            signature,
          });
        }

        return await this.onSessionConnected({
          session,
          signature: "",
        });
      }
    } catch (error) {
      Logger.error(WalletConnectV2ProviderErrorMessagesEnum.unableToLogin);
      throw new Error(WalletConnectV2ProviderErrorMessagesEnum.unableToLogin);
    } finally {
      this.isInitializing = false;
    }

    return "";
  }

  /**
   * Mocks a logout request by returning true
   */
  async logout(options?: { topic?: string }): Promise<boolean> {
    if (typeof this.walletConnector === "undefined") {
      Logger.error(WalletConnectV2ProviderErrorMessagesEnum.notInitialized);
      throw new Error(WalletConnectV2ProviderErrorMessagesEnum.notInitialized);
    }

    try {
      const topic =
        options?.topic ?? this.getCurrentTopic(this.walletConnector);
      if (topic) {
        await this.walletConnector.disconnect({
          topic,
          reason: getSdkError("USER_DISCONNECTED"),
        });
        const newPairings = this.walletConnector.core.pairing.pairings
          .getAll({ active: true })
          .filter((pairing) => pairing.topic !== topic);
        this.pairings = newPairings;
      }
    } catch {
      Logger.error(WalletConnectV2ProviderErrorMessagesEnum.alreadyLoggedOut);
    } finally {
      this.pairings = this.walletConnector.core.pairing.pairings.getAll({
        active: true,
      });
      this.reset();
    }

    return true;
  }

  /**
   * Fetches the WalletConnect address
   */
  async getAddress(): Promise<string> {
    if (typeof this.walletConnector === "undefined") {
      Logger.error(WalletConnectV2ProviderErrorMessagesEnum.notInitialized);
      throw new Error(WalletConnectV2ProviderErrorMessagesEnum.notInitialized);
    }

    return this.address;
  }

  /**
   * Fetches the WalletConnect signature
   */
  async getSignature(): Promise<string> {
    if (typeof this.walletConnector === "undefined") {
      Logger.error(WalletConnectV2ProviderErrorMessagesEnum.notInitialized);
      throw new Error(WalletConnectV2ProviderErrorMessagesEnum.notInitialized);
    }

    return this.signature;
  }

  /**
   * Fetches the WalletConnect pairings
   */
  async getPairings(): Promise<PairingTypes.Struct[] | undefined> {
    if (typeof this.walletConnector === "undefined") {
      Logger.error(WalletConnectV2ProviderErrorMessagesEnum.notInitialized);
      throw new Error(WalletConnectV2ProviderErrorMessagesEnum.notInitialized);
    }

    return (
      this.pairings ??
      this.walletConnector.core.pairing.pairings.getAll({ active: true })
    );
  }

  /**
   * Signs a message and returns it signed
   * @param message
   */
  async signMessage<T extends ISignableMessage>(message: T): Promise<T> {
    if (typeof this.walletConnector === "undefined") {
      Logger.error(WalletConnectV2ProviderErrorMessagesEnum.notInitialized);
      throw new Error(WalletConnectV2ProviderErrorMessagesEnum.notInitialized);
    }

    if (typeof this.session === "undefined") {
      Logger.error(
        WalletConnectV2ProviderErrorMessagesEnum.sessionNotConnected
      );
      this.onClientConnect.onClientLogout();
      throw new Error(
        WalletConnectV2ProviderErrorMessagesEnum.sessionNotConnected
      );
    }

    const address = await this.getAddress();
    const { signature }: { signature: Buffer } =
      await this.walletConnector.request({
        chainId: `${this.namespace}:${this.chainId}`,
        topic: this.getCurrentTopic(this.walletConnector),
        request: {
          method:
            this.namespace === WALLETCONNECT_MULTIVERSX_NAMESPACE
              ? Operation.SIGN_MESSAGE
              : OldOperation.SIGN_MESSAGE,
          params: {
            address,
            message: message.message.toString(),
          },
        },
      });

    if (!signature) {
      Logger.error(
        WalletConnectV2ProviderErrorMessagesEnum.invalidMessageResponse
      );
      throw new Error(
        WalletConnectV2ProviderErrorMessagesEnum.invalidMessageResponse
      );
    }

    try {
      message.applySignature(
        new Signature(signature),
        UserAddress.fromBech32(address)
      );
    } catch (error) {
      Logger.error(
        WalletConnectV2ProviderErrorMessagesEnum.invalidMessageSignature
      );
      throw new Error(
        WalletConnectV2ProviderErrorMessagesEnum.invalidMessageSignature
      );
    }

    return message;
  }

  /**
   * Signs a transaction and returns it signed
   * @param transaction
   */
  async signTransaction<T extends ITransaction>(transaction: T): Promise<T> {
    if (typeof this.walletConnector === "undefined") {
      Logger.error(WalletConnectV2ProviderErrorMessagesEnum.notInitialized);
      throw new Error(WalletConnectV2ProviderErrorMessagesEnum.notInitialized);
    }

    if (typeof this.session === "undefined") {
      Logger.error(
        WalletConnectV2ProviderErrorMessagesEnum.sessionNotConnected
      );
      this.onClientConnect.onClientLogout();
      throw new Error(
        WalletConnectV2ProviderErrorMessagesEnum.sessionNotConnected
      );
    }

    const address = await this.getAddress();
    const sender = new Address(address);
    const wcTransaction = transaction.toPlainObject(sender);

    if (this.chainId !== transaction.getChainID().valueOf()) {
      Logger.error(
        WalletConnectV2ProviderErrorMessagesEnum.requestDifferentChain
      );
      throw new Error(
        WalletConnectV2ProviderErrorMessagesEnum.requestDifferentChain
      );
    }

    try {
      const { signature }: { signature: string } =
        await this.walletConnector.request({
          chainId: `${this.namespace}:${this.chainId}`,
          topic: this.getCurrentTopic(this.walletConnector),
          request: {
            method:
              this.namespace === WALLETCONNECT_MULTIVERSX_NAMESPACE
                ? Operation.SIGN_TRANSACTION
                : OldOperation.SIGN_TRANSACTION,
            params: {
              transaction: wcTransaction,
            },
          },
        });

      if (!signature) {
        Logger.error(
          WalletConnectV2ProviderErrorMessagesEnum.requestDifferentChain
        );
        throw new Error(
          WalletConnectV2ProviderErrorMessagesEnum.requestDifferentChain
        );
      }

      transaction.applySignature(
        Signature.fromHex(signature),
        UserAddress.fromBech32(address)
      );
      return transaction;
    } catch (error) {
      throw new Error(
        WalletConnectV2ProviderErrorMessagesEnum.transactionError
      );
    }
  }

  /**
   * Signs an array of transactions and returns it signed
   * @param transactions
   */
  async signTransactions<T extends ITransaction>(
    transactions: T[]
  ): Promise<T[]> {
    if (typeof this.walletConnector === "undefined") {
      Logger.error(WalletConnectV2ProviderErrorMessagesEnum.notInitialized);
      throw new Error(WalletConnectV2ProviderErrorMessagesEnum.notInitialized);
    }

    if (typeof this.session === "undefined") {
      Logger.error(
        WalletConnectV2ProviderErrorMessagesEnum.sessionNotConnected
      );
      this.onClientConnect.onClientLogout();
      throw new Error(
        WalletConnectV2ProviderErrorMessagesEnum.sessionNotConnected
      );
    }

    const address = await this.getAddress();
    const sender = new Address(address);
    const wcTransactions = transactions.map((transaction) => {
      if (this.chainId !== transaction.getChainID().valueOf()) {
        Logger.error(
          WalletConnectV2ProviderErrorMessagesEnum.requestDifferentChain
        );
        throw new Error(
          WalletConnectV2ProviderErrorMessagesEnum.requestDifferentChain
        );
      }
      return transaction.toPlainObject(sender);
    });

    try {
      const { signatures }: { signatures: { signature: string }[] } =
        await this.walletConnector.request({
          chainId: `${this.namespace}:${this.chainId}`,
          topic: this.getCurrentTopic(this.walletConnector),
          request: {
            method:
              this.namespace === WALLETCONNECT_MULTIVERSX_NAMESPACE
                ? Operation.SIGN_TRANSACTIONS
                : OldOperation.SIGN_TRANSACTIONS,
            params: {
              transactions: wcTransactions,
            },
          },
        });

      if (!signatures || !Array.isArray(signatures)) {
        Logger.error(
          WalletConnectV2ProviderErrorMessagesEnum.invalidTransactionResponse
        );
      }

      if (transactions.length !== signatures.length) {
        Logger.error(
          WalletConnectV2ProviderErrorMessagesEnum.invalidTransactionResponse
        );
      }

      for (const [index, transaction] of transactions.entries()) {
        transaction.applySignature(
          Signature.fromHex(signatures[index].signature),
          UserAddress.fromBech32(address)
        );
      }

      return transactions;
    } catch (error) {
      throw new Error(
        WalletConnectV2ProviderErrorMessagesEnum.transactionError
      );
    }
  }

  /**
   * Sends a custom request
   * @param request
   */

  async sendCustomRequest(options?: {
    request: EngineTypes.RequestParams["request"];
  }): Promise<any> {
    if (typeof this.walletConnector === "undefined") {
      Logger.error(WalletConnectV2ProviderErrorMessagesEnum.notInitialized);
      throw new Error(WalletConnectV2ProviderErrorMessagesEnum.notInitialized);
    }

    if (typeof this.session === "undefined") {
      Logger.error(
        WalletConnectV2ProviderErrorMessagesEnum.sessionNotConnected
      );
      this.onClientConnect.onClientLogout();
      throw new Error(
        WalletConnectV2ProviderErrorMessagesEnum.sessionNotConnected
      );
    }

    if (options?.request?.method) {
      const request = { ...options.request };
      let { method } = request;

      // send the event based on the connected namespace even if the event uses a different namespace
      // Dapps don't know the current connected namespace, thus, we handle it here
      if (
        request.method.startsWith(WALLETCONNECT_OLD_METHOD_PREFIX) &&
        this.namespace === WALLETCONNECT_MULTIVERSX_NAMESPACE
      ) {
        method = method.replace(
          WALLETCONNECT_OLD_METHOD_PREFIX,
          this.namespace
        );
      }
      if (
        request.method.startsWith(WALLETCONNECT_MULTIVERSX_NAMESPACE) &&
        this.namespace === WALLETCONNECT_OLD_NAMESPACE
      ) {
        method = method.replace(
          WALLETCONNECT_MULTIVERSX_NAMESPACE,
          WALLETCONNECT_OLD_METHOD_PREFIX
        );
      }

      const { response }: { response: any } =
        await this.walletConnector.request({
          chainId: `${this.namespace}:${this.chainId}`,
          topic: this.getCurrentTopic(this.walletConnector),
          request: { ...request, method },
        });

      if (!response) {
        Logger.error(
          WalletConnectV2ProviderErrorMessagesEnum.invalidCustomRequestResponse
        );
        throw new Error(
          WalletConnectV2ProviderErrorMessagesEnum.invalidCustomRequestResponse
        );
      }

      return response;
    }
  }

  /**
   * Ping helper
   */

  async ping(): Promise<boolean> {
    if (typeof this.walletConnector === "undefined") {
      Logger.error(WalletConnectV2ProviderErrorMessagesEnum.notInitialized);
      throw new Error(WalletConnectV2ProviderErrorMessagesEnum.notInitialized);
    }

    if (typeof this.session === "undefined") {
      Logger.error(
        WalletConnectV2ProviderErrorMessagesEnum.sessionNotConnected
      );
      this.onClientConnect.onClientLogout();
      throw new Error(
        WalletConnectV2ProviderErrorMessagesEnum.sessionNotConnected
      );
    }

    try {
      await this.walletConnector.ping({
        topic: this.getCurrentTopic(this.walletConnector),
      });
      return true;
    } catch (error) {
      Logger.error(WalletConnectV2ProviderErrorMessagesEnum.pingFailed);
      return false;
    }
  }

  private async loginAccount(options?: {
    address: string;
    signature?: string;
  }): Promise<void> {
    if (!options) {
      return;
    }

    if (this.addressIsValid(options.address)) {
      this.address = options.address;
      if (options.signature) {
        this.signature = options.signature;
      }
      this.onClientConnect.onClientLogin();

      return;
    }

    Logger.error(
      `${WalletConnectV2ProviderErrorMessagesEnum.invalidAddress} ${options.address}`
    );
    if (this.walletConnector) {
      await this.walletConnector.disconnect({
        topic: this.getCurrentTopic(this.walletConnector),
        reason: getSdkError("USER_DISCONNECTED"),
      });
      const newPairings = this.walletConnector.core.pairing.pairings.getAll({
        active: true,
      });
      this.pairings = newPairings;
    }
  }

  private async onSessionConnected(options?: {
    session: SessionTypes.Struct;
    signature?: string;
  }): Promise<string> {
    if (!options) {
      return "";
    }

    this.session = options.session;

    // If both are present use the main one instead of the old one
    if (options.session?.namespaces?.[WALLETCONNECT_OLD_NAMESPACE]) {
      this.namespace = WALLETCONNECT_OLD_NAMESPACE;
    }

    if (options.session?.namespaces?.[WALLETCONNECT_MULTIVERSX_NAMESPACE]) {
      this.namespace = WALLETCONNECT_MULTIVERSX_NAMESPACE;
    }

    const address = this.getAddressFromSession(options.session);

    if (address) {
      await this.loginAccount({ address, signature: options.signature });
    }

    return "";
  }

  private async handleTopicUpdateEvent({
    topic,
  }: {
    topic: string;
  }): Promise<void> {
    if (typeof this.walletConnector === "undefined") {
      throw new Error(WalletConnectV2ProviderErrorMessagesEnum.notInitialized);
    }

    try {
      if (this.address && !this.isInitializing && this.pairings) {
        if (this.pairings?.length === 0) {
          this.onClientConnect.onClientLogout();
        } else {
          const lastActivePairing = this.pairings[this.pairings.length - 1];
          if (lastActivePairing?.topic === topic) {
            this.onClientConnect.onClientLogout();
          }
        }
      }
    } catch (error) {
      Logger.error(
        WalletConnectV2ProviderErrorMessagesEnum.unableToHandleTopic
      );
    } finally {
      this.pairings = this.walletConnector.core.pairing.pairings.getAll({
        active: true,
      });
    }
  }

  private async handleSessionEvents({
    topic,
    params,
  }: {
    topic: string;
    params: SessionEventTypes;
  }): Promise<void> {
    if (typeof this.walletConnector === "undefined") {
      throw new Error(WalletConnectV2ProviderErrorMessagesEnum.notInitialized);
    }

    const { event } = params;
    if (event?.name && this.getCurrentTopic(this.walletConnector) === topic) {
      const eventData = event.data;

      this.onClientConnect.onClientEvent(eventData);
    }
  }

  private async subscribeToEvents(client: Client): Promise<void> {
    if (typeof client === "undefined") {
      throw new Error(WalletConnectV2ProviderErrorMessagesEnum.notInitialized);
    }

    try {
      // Session Events
      client.on("session_update", ({ topic, params }) => {
        const { namespaces } = params;
        const _session = client.session.get(topic);
        const updatedSession = { ..._session, namespaces };
        this.onSessionConnected({ session: updatedSession });
      });

      client.on("session_event", this.handleSessionEvents.bind(this));

      client.on("session_delete", () => {
        Logger.error(WalletConnectV2ProviderErrorMessagesEnum.sessionDeleted);
        this.onClientConnect.onClientLogout();
      });
      client.on("session_expire", () => {
        Logger.error(WalletConnectV2ProviderErrorMessagesEnum.sessionExpired);
        this.onClientConnect.onClientLogout();
      });

      // Pairing Events
      client?.core?.pairing?.events.on(
        "pairing_delete",
        this.handleTopicUpdateEvent.bind(this)
      );
      client?.core?.pairing?.events.on(
        "pairing_expire",
        this.handleTopicUpdateEvent.bind(this)
      );
    } catch (error) {
      Logger.error(
        WalletConnectV2ProviderErrorMessagesEnum.unableToHandleEvent
      );
    }
  }

  private async checkPersistedState(
    client: Client
  ): Promise<SessionTypes.Struct | undefined> {
    if (typeof client === "undefined") {
      throw new Error(WalletConnectV2ProviderErrorMessagesEnum.notInitialized);
    }

    this.pairings = client.pairing.getAll({ active: true });

    if (typeof this.session !== "undefined") {
      return;
    }

    // Populates existing session to state (assume only the top one)
    if (client.session.length && !this.address && !this.isInitializing) {
      const session = this.getCurrentSession(client);
      if (session) {
        await this.onSessionConnected({ session });
        return session;
      }
    }

    return;
  }

  private getCurrentSession(client: Client): SessionTypes.Struct {
    if (typeof client === "undefined") {
      throw new Error(WalletConnectV2ProviderErrorMessagesEnum.notInitialized);
    }

    if (client.session.length) {
      const lastKeyIndex = client.session.keys.length - 1;
      const session = client.session.get(client.session.keys[lastKeyIndex]);

      return session;
    } else {
      Logger.error(
        WalletConnectV2ProviderErrorMessagesEnum.sessionNotConnected
      );
      this.onClientConnect.onClientLogout();
      throw new Error(
        WalletConnectV2ProviderErrorMessagesEnum.sessionNotConnected
      );
    }
  }

  private getCurrentTopic(client: Client): SessionTypes.Struct["topic"] {
    if (typeof client === "undefined") {
      throw new Error(WalletConnectV2ProviderErrorMessagesEnum.notInitialized);
    }

    if (client.session.length) {
      const lastKeyIndex = client.session.keys.length - 1;
      const session = client.session.get(client.session.keys[lastKeyIndex]);

      return session.topic;
    } else {
      Logger.error(
        WalletConnectV2ProviderErrorMessagesEnum.sessionNotConnected
      );
      this.onClientConnect.onClientLogout();
      throw new Error(
        WalletConnectV2ProviderErrorMessagesEnum.sessionNotConnected
      );
    }
  }

  private addressIsValid(destinationAddress: string): boolean {
    try {
      const addr = UserAddress.fromBech32(destinationAddress);
      return !!addr;
    } catch {
      return false;
    }
  }

  private getAddressFromSession(session: SessionTypes.Struct): string {
    const selectedNamespace =
      session.namespaces[this.namespace ?? WALLETCONNECT_MULTIVERSX_NAMESPACE];

    if (selectedNamespace && selectedNamespace.accounts) {
      // Use only the first address in case of multiple provided addresses
      const currentSession = selectedNamespace.accounts[0];
      const [namespace, reference, address] = currentSession.split(":");

      return address;
    }

    return "";
  }
}
