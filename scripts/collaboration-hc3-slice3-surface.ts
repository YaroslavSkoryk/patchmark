/* Test-only qualification surface. This file is never imported by production. */
import type {
  Hc3DirectWorkflowCommand,
  Hc3DirectWorkflowStatus
} from "../lib/collaboration/hc3/direct-workflow.ts";

export interface Hc3DirectQualificationSurfaceFacade {
  readonly currentStatus: Hc3DirectWorkflowStatus;
  invoke(action: Hc3DirectWorkflowCommand, pastedText: string): Promise<Hc3DirectWorkflowStatus>;
}

export function mountHc3Slice3QualificationSurface(
  root: HTMLElement,
  facade: Hc3DirectQualificationSurfaceFacade
): Readonly<{
  render(): void;
  invoke(action: Hc3DirectWorkflowCommand): Promise<void>;
  snapshot(): Readonly<Record<string, unknown>>;
}> {
  if (!(root instanceof HTMLElement)) throw new Error("HC-3 Slice 3 qualification requires an injected HTML root.");
  root.innerHTML = `
    <section aria-labelledby="hc3-direct-heading" data-hc3-slice3-surface>
      <h1 id="hc3-direct-heading">Direct connection (qualification only)</h1>
      <p>This disabled test surface never discovers peers or signals in the background.</p>
      <div id="hc3-direct-status" role="status" aria-live="polite" tabindex="-1"></div>
      <label for="hc3-direct-artifact">Connection request or response</label>
      <textarea id="hc3-direct-artifact" rows="5" spellcheck="false" autocomplete="off"></textarea>
      <div id="hc3-direct-actions" aria-describedby="hc3-direct-status"></div>
      <details><summary>Technical details</summary><code id="hc3-direct-diagnostic"></code></details>
    </section>`;
  const statusNode = required<HTMLElement>(root.querySelector("#hc3-direct-status"));
  const actionsNode = required<HTMLElement>(root.querySelector("#hc3-direct-actions"));
  const artifactNode = required<HTMLTextAreaElement>(root.querySelector("#hc3-direct-artifact"));
  const diagnosticNode = required<HTMLElement>(root.querySelector("#hc3-direct-diagnostic"));
  let busy = false;

  const api = Object.freeze({
    render,
    async invoke(action: Hc3DirectWorkflowCommand) {
      if (busy) return;
      busy = true;
      render();
      try {
        await facade.invoke(action, artifactNode.value);
        render();
        statusNode.focus();
      } finally {
        busy = false;
        render();
      }
    },
    snapshot() {
      return Object.freeze({
        state: facade.currentStatus.state,
        title: facade.currentStatus.title,
        status_text: statusNode.textContent ?? "",
        buttons: [...root.querySelectorAll<HTMLButtonElement>("button")].map((button) => ({ action: button.dataset.action, name: button.textContent, disabled: button.disabled, describedby: button.getAttribute("aria-describedby") })),
        labelled_textarea: artifactNode.labels?.length === 1,
        live_region: statusNode.getAttribute("aria-live"),
        details_open: root.querySelector("details")?.hasAttribute("open") ?? false,
        encrypted_file_fallback: [...root.querySelectorAll<HTMLButtonElement>("button")].some((button) => button.dataset.action === "use_encrypted_file")
      });
    }
  });

  function render(): void {
    const status = facade.currentStatus;
    statusNode.textContent = `${status.title}. ${status.explanation}`;
    diagnosticNode.textContent = status.technical_diagnostic_code ?? "No diagnostic.";
    actionsNode.replaceChildren(...status.available_actions.map((action) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.action = action;
      button.textContent = label(action);
      button.disabled = busy;
      button.setAttribute("aria-describedby", "hc3-direct-status");
      button.addEventListener("click", () => { void api.invoke(action); });
      return button;
    }));
  }

  render();
  return api;
}

function label(action: Hc3DirectWorkflowCommand): string {
  const labels: Record<Hc3DirectWorkflowCommand, string> = {
    create_connection_link: "Create connection link",
    copy_connection_request: "Copy connection request",
    present_connection_request_as_qr: "Show request as QR",
    open_connection_request: "Open request",
    create_connection_response: "Create response",
    copy_connection_response: "Copy connection response",
    present_connection_response_as_qr: "Show response as QR",
    open_connection_response: "Open response",
    connect_directly: "Connect",
    synchronize_directly: "Synchronize",
    cancel_direct_connection: "Cancel direct connection",
    restart_direct_connection: "Start fresh connection",
    use_encrypted_file: "Use encrypted file"
  };
  return labels[action];
}

function required<T>(value: T | null): T {
  if (value === null) throw new Error("HC-3 Slice 3 qualification surface is incomplete.");
  return value;
}
