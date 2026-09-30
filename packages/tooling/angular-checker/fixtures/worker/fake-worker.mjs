// A stand-in for the checker worker: speaks the same IPC protocol but does no
// checking, so the client's supersede / kill-and-restart / orphan rules can be
// tested against a real child process without paying for ngtsc.
//
//   code "SLOW:<ms>"  busy-waits <ms> synchronously (like a long ngtsc run)
//   code "HANG"       busy-waits forever
//   anything else     answers at once; the diagnostic message echoes the code
//   projectDir ending "-no-cli" answers init with a compiler-cli init-error
function busyWait(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {}
}

process.on("disconnect", () => process.exit(0));

process.on("message", (msg) => {
  switch (msg.type) {
    case "init":
      if (msg.projectDir.endsWith("-no-cli")) {
        process.send({
          type: "init-error",
          kind: "compiler-cli",
          message: "no compiler-cli",
        });
      } else {
        process.send({ type: "ready" });
      }
      break;
    case "check": {
      if (msg.code === "HANG") for (;;) busyWait(1000);
      const slow = /^SLOW:(\d+)$/.exec(msg.code);
      if (slow) busyWait(Number(slow[1]));
      process.send({
        type: "result",
        requestId: msg.requestId,
        diagnostics: [
          {
            file: msg.virtualPath,
            start: 0,
            length: 1,
            code: 1,
            message: msg.code,
            category: "error",
            source: "ngtsc",
          },
        ],
      });
      break;
    }
    case "configDiagnostics":
      process.send({
        type: "result",
        requestId: msg.requestId,
        diagnostics: [],
      });
      break;
    case "dispose":
      process.exit(0);
  }
});
