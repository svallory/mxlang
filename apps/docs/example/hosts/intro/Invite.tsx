import { Dialog } from "./Dialog.tsx";

export function Invite({ team, open, send }: { team: string; open: boolean; send: () => void }) {
  return (
    <Dialog
      open={open}
      title={
        <>
          Invite to <b>{team}</b>
        </>
      }
      actions={
        <button className="primary" onClick={send}>
          Send invite
        </button>
      }
    >
      <input name="email" id="email" className="field" type="email" required />
    </Dialog>
  );
}
