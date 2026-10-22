import { createFileRoute, redirect } from "@tanstack/react-router";

import {
  OperationsDashboard,
  OperationsProjectNamesFromServer,
} from "../components/operations/OperationsDashboard";
import { SidebarInset } from "../components/ui/sidebar";

// Fixture tasks stay until this environment's board feed sends a live card.
export const Route = createFileRoute("/operations")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: OperationsRoute,
});

function OperationsRoute() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <OperationsProjectNamesFromServer>
        <OperationsDashboard />
      </OperationsProjectNamesFromServer>
    </SidebarInset>
  );
}
