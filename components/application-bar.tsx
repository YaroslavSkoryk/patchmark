import { type ReactNode } from "react";
import {
  ActionMenu,
  ActionMenuGroup,
  ActionMenuItem
} from "@/components/action-menu";

type ApplicationBarProps = {
  actions: ReactNode;
  children: ReactNode;
};

type ApplicationMenuProps = {
  children: (closeMenu: () => void) => ReactNode;
  label: string;
};

type ApplicationMenuGroupProps = {
  children: ReactNode;
  label: string;
};

type ApplicationMenuItemProps = {
  busy?: boolean;
  children: ReactNode;
  disabled?: boolean;
  onSelect: () => void | Promise<void>;
  closeMenu: () => void;
};

export function ApplicationBar({ actions, children }: ApplicationBarProps) {
  return (
    <header
      className="application-bar"
      aria-label="Patchmark application"
      role="banner"
    >
      <nav className="application-bar-actions" aria-label="Application actions">
        {actions}
      </nav>
      <div className="application-bar-document">{children}</div>
    </header>
  );
}

export function ApplicationMenu({ children, label }: ApplicationMenuProps) {
  return (
    <ActionMenu
      label={`${label} menu`}
      rootClassName="application-menu"
      triggerClassName="application-menu-trigger"
      triggerChildren={
        <>
          <span className="application-menu-label">{label}</span>
          <span
            className="application-menu-label-compact"
            data-compact-label={label === "Review" ? "Rev" : label}
            aria-hidden="true"
          />
        </>
      }
      panelClassName="application-menu-panel"
    >
      {children}
    </ActionMenu>
  );
}

export function ApplicationMenuGroup({
  children,
  label
}: ApplicationMenuGroupProps) {
  return (
    <ActionMenuGroup
      className="application-menu-group"
      label={label}
      labelClassName="application-menu-group-label"
    >
      {children}
    </ActionMenuGroup>
  );
}

export function ApplicationMenuItem({
  busy = false,
  children,
  closeMenu,
  disabled = false,
  onSelect
}: ApplicationMenuItemProps) {
  return (
    <ActionMenuItem
      busy={busy}
      className="application-menu-item"
      closeMenu={closeMenu}
      disabled={disabled}
      onSelect={onSelect}
    >
      {children}
    </ActionMenuItem>
  );
}
