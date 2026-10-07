export function TryCatch() {
  return (
    <div>
      <Errored
        fallback={(__mxErr, reset) => {
          const e = __mxErr();
          return (
            <p>
              caught: {e.message}:{typeof reset}
            </p>
          );
        }}
      >
        <Loading>
          <Risky />
        </Loading>
      </Errored>
      <Errored
        fallback={(__mxErr) => {
          const { message } = __mxErr();
          return <p>msg: {message}</p>;
        }}
      >
        <Loading>
          <Risky />
        </Loading>
      </Errored>
      <Errored fallback={() => <p>failed</p>}>
        <Loading>
          <Risky />
        </Loading>
      </Errored>
      <Loading fallback={<>loading…</>}>
        <Slow />
      </Loading>
    </div>
  );
}

function Risky() {
  return <span>risky</span>;
}

function Slow() {
  return <span>slow</span>;
}
