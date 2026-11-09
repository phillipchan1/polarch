import { useStore } from "../store/useStore";
import {
  DomainsModal,
  ManagerModal,
  PersonModal,
  TeamModal,
} from "./forms";
import { TriageModal } from "./TriageModal";
import { CaptureDialog } from "./shell/CaptureDialog";
import { QuickCloseSheet } from "./QuickCloseSheet";

/**
 * Renders whatever `modal` state names, from anywhere in the app.
 *
 * These five used to be rendered inside `OrgTree`, which meant `openModal` only
 * did anything while the tree tab was mounted. That was invisible on a desktop,
 * where every create button also lived on the canvas — but it's the reason a
 * "+ Add person" anywhere else would have set state and shown nothing.
 *
 * Mounted once at the app root beside `<ConfirmHost />` and `<ToastHost />`,
 * which is the pattern this app already uses for anything that has to be
 * reachable regardless of which surface asked for it.
 */
export function ModalHost() {
  const modal = useStore((s) => s.modal);
  const closeModal = useStore((s) => s.closeModal);

  if (!modal) return null;

  switch (modal.kind) {
    case "team":
      return (
        <TeamModal
          team={modal.team}
          defaultParentId={modal.parentId}
          defaultLeaderId={modal.leaderId}
          onClose={closeModal}
        />
      );
    case "manager":
      return <ManagerModal manager={modal.manager} onClose={closeModal} />;
    case "person":
      return (
        <PersonModal
          person={modal.person}
          defaultTeamId={modal.teamId}
          onClose={closeModal}
        />
      );
    case "domains":
      return <DomainsModal onClose={closeModal} />;
    case "triage":
      return <TriageModal onClose={closeModal} />;
    case "capture":
      return <CaptureDialog draft={modal.draft} onClose={closeModal} />;
    case "quickClose":
      return <QuickCloseSheet sessionId={modal.sessionId} onClose={closeModal} />;
  }
}
