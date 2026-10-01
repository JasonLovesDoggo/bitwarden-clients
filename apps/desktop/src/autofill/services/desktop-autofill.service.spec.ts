import { mock, MockProxy } from "jest-mock-extended";
import { BehaviorSubject } from "rxjs";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { AuthService } from "@bitwarden/common/auth/abstractions/auth.service";
import { AuthenticationStatus } from "@bitwarden/common/auth/enums/authentication-status";
import { DeviceType } from "@bitwarden/common/enums";
import { ConfigService } from "@bitwarden/common/platform/abstractions/config/config.service";
import { Fido2AuthenticatorService as Fido2AuthenticatorServiceAbstraction } from "@bitwarden/common/platform/abstractions/fido2/fido2-authenticator.service.abstraction";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { PlatformUtilsService } from "@bitwarden/common/platform/abstractions/platform-utils.service";
import { UserId } from "@bitwarden/common/types/guid";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { CipherRepromptType, CipherType } from "@bitwarden/common/vault/enums";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import { LoginUriView } from "@bitwarden/common/vault/models/view/login-uri.view";

import { DesktopAutofillService } from "./desktop-autofill.service";
import { NativeWindowObject } from "./desktop-fido2-user-interface.service";

describe("DesktopAutofillService", () => {
  let logService: MockProxy<LogService>;
  let cipherService: MockProxy<CipherService>;
  let configService: MockProxy<ConfigService>;
  let fido2AuthenticatorService: MockProxy<
    Fido2AuthenticatorServiceAbstraction<NativeWindowObject>
  >;
  let accountService: MockProxy<AccountService>;
  let authService: MockProxy<AuthService>;
  let platformUtilsService: MockProxy<PlatformUtilsService>;

  let activeAccountStatus$: BehaviorSubject<AuthenticationStatus>;
  let service: DesktopAutofillService;

  beforeEach(() => {
    logService = mock<LogService>();
    cipherService = mock<CipherService>();
    configService = mock<ConfigService>();
    fido2AuthenticatorService = mock<Fido2AuthenticatorServiceAbstraction<NativeWindowObject>>();
    accountService = mock<AccountService>();
    authService = mock<AuthService>();
    platformUtilsService = mock<PlatformUtilsService>();

    activeAccountStatus$ = new BehaviorSubject<AuthenticationStatus>(AuthenticationStatus.Unlocked);
    authService.activeAccountStatus$ = activeAccountStatus$;

    platformUtilsService.getDevice.mockReturnValue(DeviceType.MacOsDesktop);

    service = new DesktopAutofillService(
      logService,
      cipherService,
      configService,
      fido2AuthenticatorService,
      accountService,
      authService,
      platformUtilsService,
    );
  });

  describe("doLockStatus", () => {
    it("reports unlocked when the active account status is Unlocked", async () => {
      activeAccountStatus$.next(AuthenticationStatus.Unlocked);

      await expect(service.doLockStatus()).resolves.toEqual({ isUnlocked: true });
    });

    it("reports locked when the active account status is Locked", async () => {
      activeAccountStatus$.next(AuthenticationStatus.Locked);

      await expect(service.doLockStatus()).resolves.toEqual({ isUnlocked: false });
    });

    it("reports locked when the active account status is LoggedOut", async () => {
      activeAccountStatus$.next(AuthenticationStatus.LoggedOut);

      await expect(service.doLockStatus()).resolves.toEqual({ isUnlocked: false });
    });
  });

  describe("selected password credentials", () => {
    // jsdom 26 omits this API; Electron's AbortSignal implements it natively.
    const originalThrowIfAborted = AbortSignal.prototype.throwIfAborted;
    beforeAll(() => {
      AbortSignal.prototype.throwIfAborted = function () {
        if (this.aborted) {
          throw this.reason;
        }
      };
    });
    afterAll(() => {
      AbortSignal.prototype.throwIfAborted = originalThrowIfAborted;
    });
    const userId = "00000000-0000-0000-0000-000000000001" as UserId;
    const request = {
      recordIdentifier: "login-1",
      serviceIdentifier: "https://example.com",
      username: "alice",
      context: "password-1",
    };
    let account$: BehaviorSubject<any>;
    let ciphers$: BehaviorSubject<CipherView[] | null>;
    let cipher: CipherView;
    let runCommand: jest.Mock;

    beforeEach(() => {
      (service as any).isEnabled = true;
      account$ = new BehaviorSubject({ id: userId });
      accountService.activeAccount$ = account$;
      cipher = new CipherView();
      cipher.id = request.recordIdentifier;
      cipher.login.username = request.username;
      cipher.login.password = "synthetic-password";
      const uri = new LoginUriView();
      uri.uri = request.serviceIdentifier;
      cipher.login.uris = [uri];
      ciphers$ = new BehaviorSubject<CipherView[] | null>([cipher]);
      cipherService.cipherViews$.mockReturnValue(ciphers$);
      runCommand = jest.fn().mockResolvedValue({ type: "success", value: { outcome: "verified" } });
      (global as any).ipc = { autofill: { desktopAutofill: { runCommand } } };
    });

    afterEach(() => delete (global as any).ipc);

    it("returns the selected current password only after native authorization", async () => {
      await expect(service.doPasswordCredential(request, new AbortController())).resolves.toEqual({
        username: "alice",
        password: "synthetic-password",
      });
      expect(runCommand).toHaveBeenCalledWith(
        expect.objectContaining({ command: "userVerification" }),
      );
    });

    it.each([
      [
        "deleted",
        (c: CipherView) => {
          c.deletedDate = new Date();
        },
      ],
      [
        "archived",
        (c: CipherView) => {
          c.archivedDate = new Date();
        },
      ],
      [
        "reprompt",
        (c: CipherView) => {
          c.reprompt = CipherRepromptType.Password;
        },
      ],
      [
        "wrong type",
        (c: CipherView) => {
          c.type = CipherType.Card;
        },
      ],
      [
        "empty password",
        (c: CipherView) => {
          c.login.password = "";
        },
      ],
      [
        "changed username",
        (c: CipherView) => {
          c.login.username = "bob";
        },
      ],
      [
        "changed URI",
        (c: CipherView) => {
          c.login.uris![0].uri = "https://other.example";
        },
      ],
    ])("rejects a %s identity before authorization", async (_name, change) => {
      change(cipher);
      await expect(service.doPasswordCredential(request, new AbortController())).rejects.toThrow();
      expect(runCommand).not.toHaveBeenCalled();
    });

    it.each([AuthenticationStatus.Locked, AuthenticationStatus.LoggedOut])(
      "rejects unavailable vault status %s",
      async (status) => {
        activeAccountStatus$.next(status);
        await expect(
          service.doPasswordCredential(request, new AbortController()),
        ).rejects.toThrow();
        expect(runCommand).not.toHaveBeenCalled();
      },
    );

    it.each([null, []])("rejects an unavailable cipher collection %j", async (collection) => {
      ciphers$.next(collection);
      await expect(service.doPasswordCredential(request, new AbortController())).rejects.toThrow(
        "selected password identity is unavailable",
      );
      expect(runCommand).not.toHaveBeenCalled();
    });

    it.each([
      { type: "success", value: { outcome: "cancelled" } },
      { type: "error", error: "verification unavailable" },
    ])("rejects unsuccessful verification %j", async (result) => {
      runCommand.mockResolvedValue(result);
      await expect(service.doPasswordCredential(request, new AbortController())).rejects.toThrow(
        "not authorized",
      );
    });

    it.each(["lock", "account", "disable", "cancel", "delete", "reprompt"])(
      "rejects %s during authorization",
      async (change) => {
        const abort = new AbortController();
        runCommand.mockImplementation(async () => {
          if (change === "lock") {
            activeAccountStatus$.next(AuthenticationStatus.Locked);
          }
          if (change === "account") {
            account$.next({ id: "other-user" });
          }
          if (change === "disable") {
            (service as any).isEnabled = false;
          }
          if (change === "cancel") {
            abort.abort(new Error("cancelled"));
          }
          if (change === "delete") {
            ciphers$.next([]);
          }
          if (change === "reprompt") {
            cipher.reprompt = CipherRepromptType.Password;
          }
          return { type: "success", value: { outcome: "verified" } };
        });
        await expect(service.doPasswordCredential(request, abort)).rejects.toThrow();
      },
    );

    it("reads the latest password after authorization", async () => {
      runCommand.mockImplementation(async () => {
        const updated = new CipherView();
        Object.assign(updated, cipher);
        updated.login = { ...cipher.login, password: "updated-synthetic-password" } as any;
        ciphers$.next([updated]);
        return { type: "success", value: { outcome: "verified" } };
      });
      await expect(service.doPasswordCredential(request, new AbortController())).resolves.toEqual({
        username: "alice",
        password: "updated-synthetic-password",
      });
    });
  });

  describe("doCancelRequest", () => {
    it("aborts the in-flight request matching the context", async () => {
      const controller = new AbortController();
      (service as any).inFlightRequests["ctx-1"] = controller;

      await service.doCancelRequest("ctx-1");

      expect(controller.signal.aborted).toBe(true);
      expect(controller.signal.reason).toBe("Operation cancelled");
    });

    it("does nothing when the context does not match an in-flight request", async () => {
      await expect(service.doCancelRequest("unknown")).resolves.toBeUndefined();
    });
  });

  describe("makeListener request correlation", () => {
    beforeEach(() => {
      // `makeListener` reads `ipc.autofill.desktopAutofill` to derive a log name.
      (global as any).ipc = { autofill: { desktopAutofill: {} } };
      // Correlation only runs once the feature flag has enabled the service.
      (service as any).isEnabled = true;
    });

    afterEach(() => {
      delete (global as any).ipc;
    });

    // Registers a handler the way `listenIpc` does and returns the listener the
    // autofill IPC server would invoke on an incoming message.
    type CapturedListener<Request> = (
      clientId: number,
      sequenceNumber: number,
      request: Request,
      completeCallback?: (error: Error | null, response: unknown) => void,
    ) => Promise<void>;

    function registerListener<Request>(
      handleFn: (request: Request, abortController: AbortController) => Promise<unknown>,
      deriveTransactionIdFn?: (request: Request) => string,
    ): CapturedListener<Request> {
      let listener!: CapturedListener<Request>;
      const channelBindFn = jest.fn((registered) => (listener = registered));
      service.makeListener(channelBindFn as any, handleFn as any, deriveTransactionIdFn as any);
      return listener;
    }

    it("delivers the abort event to the subscribed handler when the request is cancelled", async () => {
      const context = "txn-3";
      const abortListener = jest.fn();
      let finishHandler!: (response: unknown) => void;
      const handlerDone = new Promise((resolve) => (finishHandler = resolve));

      // Mirrors the real consumer: the handler reacts to the abort event
      // (rather than polling `signal.aborted`) and then settles.
      const requestListener = registerListener<{ context: string }>(
        (_request, abortController) => {
          abortController.signal.addEventListener(
            "abort",
            () => {
              abortListener(abortController.signal.reason);
              finishHandler({ cancelled: true });
            },
            { once: true },
          );
          return handlerDone;
        },
        (request) => request.context,
      );
      const cancelListener = registerListener<string>((ctx) => service.doCancelRequest(ctx));

      const completeCallback = jest.fn();
      const processing = requestListener(1, 2, { context }, completeCallback);

      // Deliver a cancellation the same way the IPC server would.
      await cancelListener(3, 4, context);
      await processing;

      expect(abortListener).toHaveBeenCalledWith("Operation cancelled");
      expect(completeCallback).toHaveBeenCalledWith(null, { cancelled: true });
      expect((service as any).inFlightRequests[context]).toBeUndefined();
    });

    it("cleans up the in-flight entry when the handler throws", async () => {
      const context = "txn-2";
      const completeCallback = jest.fn();

      const requestListener = registerListener<{ context: string }>(
        () => Promise.reject(new Error("boom")),
        (request) => request.context,
      );

      await requestListener(1, 2, { context }, completeCallback);

      expect(completeCallback).toHaveBeenCalledWith(expect.any(Error), null);
      expect((service as any).inFlightRequests[context]).toBeUndefined();
    });
  });
});
