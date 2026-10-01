// Run after building the debug native module: node --test tests/password-credential.test.cjs
const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const net = require("node:net");
const { once } = require("node:events");
const { test } = require("node:test");

function readFrame(socket) {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    socket.once("error", reject);
    function onData(chunk) {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length >= 4 && bytes.length >= bytes.readUInt32LE() + 4) {
        socket.removeListener("data", onData);
        socket.removeListener("error", reject);
        resolve(bytes);
      }
    }
    socket.on("data", onData);
  });
}

function sendFrame(socket, message) {
  const payload = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  socket.write(Buffer.concat([header, payload]));
}

test("a password response reaches only the requesting IPC client", { timeout: 5000 }, async () => {
  const directory = await mkdtemp("/tmp/bw-af-test-");
  process.env.BITWARDEN_IPC_SOCKET_DIR = directory;
  const { autofill } = require("../index.js");
  const callbacks = {
    registrationCallback() {},
    assertionCallback() {},
    assertionWithoutUserInterfaceCallback() {},
    nativeStatusCallback() {},
    lockStatusCallback(error, clientId, sequenceNumber) {
      assert.ifError(error);
      server.completeLockStatus(clientId, sequenceNumber, { isUnlocked: true });
    },
    windowHandleQueryCallback() {},
    cancelRequestCallback() {},
    passwordCredentialCallback(error, clientId, sequenceNumber) {
      assert.ifError(error);
      server.completePasswordCredential(clientId, sequenceNumber, {
        username: "synthetic-user",
        password: "synthetic-password",
      });
    },
  };
  const server = await autofill.AutofillIpcServer.listen("af", callbacks);
  const requesting = net.createConnection(server.getPaths()[0]);
  const observer = net.createConnection(server.getPaths()[0]);
  try {
    await Promise.all([once(requesting, "connect"), once(observer, "connect")]);
    // An acknowledgement proves the observer is subscribed before the password response.
    const acknowledgement = readFrame(observer);
    sendFrame(observer, { sequenceNumber: 6, request: "lockStatus" });
    assert.deepEqual(JSON.parse((await acknowledgement).subarray(4).toString()), {
      sequence_number: 6,
      value: { Ok: { isUnlocked: true } },
    });
    const observed = [];
    observer.on("data", (chunk) => observed.push(chunk));
    const response = readFrame(requesting);
    sendFrame(requesting, {
      sequenceNumber: 7,
      request: "passwordCredential",
      params: {
        recordIdentifier: "synthetic-login",
        serviceIdentifier: "https://example.com",
        username: "synthetic-user",
        context: "synthetic-request",
      },
    });
    const bytes = await response;
    assert.equal(bytes.readUInt32LE(), bytes.length - 4);
    assert.deepEqual(JSON.parse(bytes.subarray(4).toString()), {
      sequence_number: 7,
      value: { Ok: { username: "synthetic-user", password: "synthetic-password" } },
    });
    // Give an incorrectly broadcast response time to reach the other live connection.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(observed.length, 0);
  } finally {
    requesting.destroy();
    observer.destroy();
    server.stop();
    delete process.env.BITWARDEN_IPC_SOCKET_DIR;
    await rm(directory, { recursive: true, force: true });
  }
});
