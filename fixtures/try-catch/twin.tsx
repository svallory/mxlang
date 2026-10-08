export function TryCatch() {
  return (
    <div>
      <Errored
        fallback={(__mxErr, ...__mxArgs) =>
          ((e, reset) => (
            <p>
              caught: {e.message}:{typeof reset}
            </p>
          ))(__mxErr(), ...__mxArgs)
        }
      >
        <Loading>
          <Risky />
        </Loading>
      </Errored>
      <Errored
        fallback={(__mxErr, ...__mxArgs) =>
          (({ message }) => <p>msg: {message}</p>)(__mxErr(), ...__mxArgs)
        }
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
