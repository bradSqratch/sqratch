"use client";

import { useEffect, useMemo, useState } from "react";
import {
  fetchJson,
  getErrorMessage,
} from "@/components/experience/client-utils";
import { Button } from "@/components/ui/button";
import { isValidEmail } from "@/lib/email-validation";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type UserRole = "USER" | "CREATOR" | "BRAND_ADMIN" | "ADMIN";

type UserRecord = {
  id: string;
  name: string | null;
  email: string;
  role: UserRole;
  createdAt: string;
  isActive: boolean;
  hasCreatorProfile: boolean;
  brands: Array<{
    id: string;
    name: string;
    slug: string;
    membershipRole: "ADMIN" | "MANAGER" | "VIEWER";
  }>;
};

type CreateForm = {
  name: string;
  email: string;
  password: string;
  role: UserRole;
};

type EditForm = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  isActive: boolean;
};

const roles: UserRole[] = [
  "USER",
  "CREATOR",
  "BRAND_ADMIN",
  "ADMIN",
];

const emptyCreateForm: CreateForm = {
  name: "",
  email: "",
  password: "",
  role: "USER",
};

const shortDateFormatter = new Intl.DateTimeFormat(undefined, {
  year: "2-digit",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function formatDateTime(value: string) {
  return shortDateFormatter.format(new Date(value));
}

function MembershipBadges({ user }: { user: UserRecord }) {
  const memberships = useMemo(() => {
    const items: string[] = [];
    if (user.hasCreatorProfile) {
      items.push("Creator");
    }
    user.brands.forEach((brand) => {
      items.push(`${brand.name} (${brand.membershipRole})`);
    });
    return items;
  }, [user]);

  if (memberships.length === 0) {
    return <span className="text-sm text-copy-35">None</span>;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {memberships.map((label) => (
        <span
          key={label}
          className="rounded-full border border-edge/10 bg-white/[0.03] px-3 py-1 text-xs text-copy-75"
        >
          {label}
        </span>
      ))}
    </div>
  );
}

export default function AdminUserManagementPage() {
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserRecord | null>(null);
  const [createForm, setCreateForm] = useState<CreateForm>(emptyCreateForm);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<{
    type: "success" | "warning";
    text: string;
  } | null>(null);
  const [transferEmail, setTransferEmail] = useState("");
  const [transferConfirmOpen, setTransferConfirmOpen] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [transferError, setTransferError] = useState<string | null>(null);
  const editingUser = editForm
    ? users.find((user) => user.id === editForm.id) ?? null
    : null;
  const transferEmailValid = isValidEmail(transferEmail);
  const canTransferEmail = Boolean(editingUser && editingUser.role !== "ADMIN");

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadUsers(query);
    }, 250);

    return () => window.clearTimeout(timeout);
  }, [query]);

  useEffect(() => {
    void loadUsers("");
  }, []);

  async function loadUsers(currentQuery: string) {
    setLoading(true);
    setError(null);

    try {
      const searchParams = new URLSearchParams();
      if (currentQuery.trim()) {
        searchParams.set("q", currentQuery.trim());
      }

      const data = await fetchJson<UserRecord[]>(
        `/api/admin/user-management/get-or-create-users${searchParams.toString() ? `?${searchParams.toString()}` : ""}`,
      );
      setUsers(data);
    } catch (loadError) {
      setError(getErrorMessage(loadError, "Failed to load users."));
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateUser() {
    setNotice(null);
    setSubmitting(true);
    setError(null);

    try {
      await fetchJson("/api/admin/user-management/get-or-create-users", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(createForm),
      });
      setCreateOpen(false);
      setCreateForm(emptyCreateForm);
      await loadUsers(query);
    } catch (createError) {
      setError(getErrorMessage(createError, "Failed to create user."));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSaveEdit() {
    setNotice(null);
    if (!editForm) {
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      await fetchJson(
        `/api/admin/user-management/update-or-delete-users/${editForm.id}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(editForm),
        },
      );
      setEditForm(null);
      await loadUsers(query);
    } catch (saveError) {
      setError(getErrorMessage(saveError, "Failed to update user."));
    } finally {
      setSubmitting(false);
    }
  }

  useEffect(() => {
    setTransferEmail("");
    setTransferError(null);
    setTransferConfirmOpen(false);
  }, [editForm?.id]);

  async function handleTransferEmail() {
    if (!editForm || !isValidEmail(transferEmail)) {
      return;
    }

    setTransferring(true);
    setTransferError(null);

    try {
      const result = await fetchJson<{
        ok: boolean;
        emailSent: boolean;
        email: string;
      }>(`/api/admin/user-management/transfer-email/${editForm.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newEmail: transferEmail }),
      });

      setTransferConfirmOpen(false);
      setEditForm(null);
      setNotice(
        result.emailSent
          ? {
              type: "success",
              text: `Email transferred to ${result.email}. A verification code was sent there; the user must verify it before logging in.`,
            }
          : {
              type: "warning",
              text: `Email transferred to ${result.email}, but the verification email could not be sent. Ask the user to open /verify-email?email=${result.email} and use Resend code.`,
            },
      );
      await loadUsers(query);
    } catch (transferFailure) {
      setTransferConfirmOpen(false);
      setTransferError(
        getErrorMessage(transferFailure, "Failed to transfer email."),
      );
    } finally {
      setTransferring(false);
    }
  }

  async function handleDeleteUser() {
    setNotice(null);
    if (!deleteTarget) {
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      await fetchJson(
        `/api/admin/user-management/update-or-delete-users/${deleteTarget.id}`,
        {
          method: "DELETE",
        },
      );
      setDeleteTarget(null);
      await loadUsers(query);
    } catch (deleteError) {
      setError(getErrorMessage(deleteError, "Failed to delete user."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6 p-6 text-ink sm:p-8">
      <div className="rounded-[28px] border border-border dark:border-[#28456C] bg-card dark:bg-[#0B183D]/90 px-6 py-7 shadow-[0_8px_28px_rgba(72,57,34,0.06)] dark:shadow-[0_20px_80px_rgba(0,0,0,0.35)] sm:px-8">
        <div className="flex flex-col gap-4 border-b border-edge/10 pb-6 xl:flex-row xl:items-center xl:justify-between">
          <div className="space-y-1">
            <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight">
              Admin Users
            </h1>
            <p className="text-sm text-copy-60">
              Search users and manage their roles and details with full
              edit controls.
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by name or email"
              className="h-10 w-full border-edge/10 bg-white/[0.04] text-ink placeholder:text-copy-35 sm:w-72"
            />
            <Button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="h-10 rounded-xl bg-[#4EA3FF] px-5 text-white hover:bg-[#4098f7]"
            >
              Create User
            </Button>
          </div>
        </div>

        {notice && (
          <div
            className={`mt-5 flex items-start justify-between gap-3 rounded-xl border px-4 py-3 text-sm ${
              notice.type === "success"
                ? "border-emerald-400/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200"
                : "border-amber-400/25 bg-amber-500/10 text-amber-700 dark:text-amber-100"
            }`}
          >
            <span>{notice.text}</span>
            <button
              type="button"
              className="shrink-0 text-copy-60 hover:text-ink"
              onClick={() => setNotice(null)}
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        )}

        {error && (
          <div className="mt-5 rounded-xl border border-red-400/25 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-200">
            {error}
          </div>
        )}

        <div className="mt-6 overflow-hidden rounded-2xl border border-edge/10">
          <Table className="min-w-[1040px] bg-transparent text-ink">
            <TableHeader className="[&_tr]:border-edge/10">
              <TableRow className="border-edge/10 bg-white/[0.02] hover:bg-white/[0.02]">
                <TableHead className="px-4 py-4 text-sm font-medium text-copy-75">
                  Name
                </TableHead>
                <TableHead className="py-4 text-sm font-medium text-copy-75">
                  Email
                </TableHead>
                <TableHead className="py-4 text-sm font-medium text-copy-75">
                  Role
                </TableHead>
                <TableHead className="py-4 text-sm font-medium text-copy-75">
                  Creator/Brand
                </TableHead>
                <TableHead className="py-4 text-sm font-medium text-copy-75">
                  Created At
                </TableHead>
                <TableHead className="py-4 text-sm font-medium text-copy-75">
                  Status
                </TableHead>
                <TableHead className="py-4 text-sm font-medium text-copy-75">
                  Actions
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="[&_tr:last-child]:border-b-0">
              {loading ? (
                <TableRow className="border-edge/10 hover:bg-transparent">
                  <TableCell
                    colSpan={7}
                    className="px-4 py-8 text-center text-copy-60"
                  >
                    Loading users...
                  </TableCell>
                </TableRow>
              ) : users.length === 0 ? (
                <TableRow className="border-edge/10 hover:bg-transparent">
                  <TableCell
                    colSpan={7}
                    className="px-4 py-8 text-center text-copy-60"
                  >
                    No users found.
                  </TableCell>
                </TableRow>
              ) : (
                users.map((user) => (
                  <TableRow
                    key={user.id}
                    className="border-edge/10 text-copy-90 hover:bg-white/[0.03]"
                  >
                    <TableCell className="px-4 py-4 text-base font-medium text-ink">
                      {user.name || "Unnamed user"}
                    </TableCell>
                    <TableCell className="py-4 text-sm text-copy-80">
                      {user.email}
                    </TableCell>
                    <TableCell className="py-4 text-sm text-copy-80">
                      {user.role}
                    </TableCell>
                    <TableCell className="py-4">
                      <MembershipBadges user={user} />
                    </TableCell>
                    <TableCell className="py-4 text-sm text-copy-80">
                      {formatDateTime(user.createdAt)}
                    </TableCell>
                    <TableCell className="py-4">
                      <span
                        className={`rounded-full border px-3 py-1 text-xs ${
                          user.isActive
                            ? "border-emerald-400/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200"
                            : "border-edge/10 bg-white/[0.04] text-copy-65"
                        }`}
                      >
                        {user.isActive ? "Active" : "Disabled"}
                      </span>
                    </TableCell>
                    <TableCell className="py-4">
                      <div className="flex gap-3">
                        <Button
                          type="button"
                          variant="outline"
                          className="h-8 rounded-xl border-border dark:border-[#35507D] bg-transparent px-5 text-ink hover:bg-white/[0.06] hover:text-ink"
                          onClick={() =>
                            setEditForm({
                              id: user.id,
                              name: user.name || "",
                              email: user.email,
                              role: user.role,
                              isActive: user.isActive,
                            })
                          }
                        >
                          Edit
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          className="h-8 rounded-xl bg-[#C85A63] px-5 text-white hover:bg-[#b94b54]"
                          onClick={() => setDeleteTarget(user)}
                        >
                          Delete
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="border-edge/10 bg-card dark:bg-[#0B183D] text-ink sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Create User</DialogTitle>
            <DialogDescription className="text-copy-60">
              Create a new user and send a verification email.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="create-name">Name</Label>
              <Input
                id="create-name"
                value={createForm.name}
                onChange={(event) =>
                  setCreateForm((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
                className="border-edge/10 bg-white/[0.04] text-ink"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="create-email">Email</Label>
              <Input
                id="create-email"
                type="email"
                value={createForm.email}
                onChange={(event) =>
                  setCreateForm((current) => ({
                    ...current,
                    email: event.target.value,
                  }))
                }
                className="border-edge/10 bg-white/[0.04] text-ink"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="create-password">Password</Label>
              <Input
                id="create-password"
                type="password"
                value={createForm.password}
                onChange={(event) =>
                  setCreateForm((current) => ({
                    ...current,
                    password: event.target.value,
                  }))
                }
                className="border-edge/10 bg-white/[0.04] text-ink"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="create-role">Role</Label>
              <select
                id="create-role"
                value={createForm.role}
                onChange={(event) =>
                  setCreateForm((current) => ({
                    ...current,
                    role: event.target.value as UserRole,
                  }))
                }
                className="h-10 rounded-md border border-edge/10 bg-white/[0.04] px-3 text-sm text-ink outline-none"
              >
                {roles.map((role) => (
                  <option key={role} value={role} className="bg-popover text-popover-foreground">
                    {role}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="border-edge/10 bg-transparent text-ink hover:bg-glass-10"
              onClick={() => setCreateOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="bg-[#4EA3FF] text-white hover:bg-[#4098f7]"
              disabled={submitting}
              onClick={() => void handleCreateUser()}
            >
              {submitting ? "Creating..." : "Create User"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(editForm)}
        onOpenChange={(open) => !open && setEditForm(null)}
      >
        <DialogContent className="border-edge/10 bg-card dark:bg-[#0B183D] text-ink sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Edit User</DialogTitle>
            <DialogDescription className="text-copy-60">
              Update user details, role, and active state.
            </DialogDescription>
          </DialogHeader>

          {editForm && (
            <div className="grid gap-4 py-2">
              <div className="space-y-2">
                <Label htmlFor="edit-name">Name</Label>
                <Input
                  id="edit-name"
                  value={editForm.name}
                  onChange={(event) =>
                    setEditForm((current) =>
                      current
                        ? {
                            ...current,
                            name: event.target.value,
                          }
                        : current,
                    )
                  }
                  className="border-edge/10 bg-white/[0.04] text-ink"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="edit-email">Email</Label>
                <Input
                  id="edit-email"
                  type="email"
                  value={editForm.email}
                  readOnly
                  aria-readonly="true"
                  className="border-edge/10 bg-white/[0.04] text-copy-70"
                />
                <p className="text-xs text-copy-45">
                  {canTransferEmail
                    ? "To change this address, use Transfer email below."
                    : "Admin emails can't be changed from this screen."}
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="edit-role">Role</Label>
                <select
                  id="edit-role"
                  value={editForm.role}
                  onChange={(event) =>
                    setEditForm((current) =>
                      current
                        ? {
                            ...current,
                            role: event.target.value as UserRole,
                          }
                        : current,
                    )
                  }
                  className="h-10 rounded-md border border-edge/10 bg-white/[0.04] px-3 text-sm text-ink outline-none"
                >
                  {roles.map((role) => (
                    <option key={role} value={role} className="bg-popover text-popover-foreground">
                      {role}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-3">
                <Label>Account Status</Label>
                <Button
                  type="button"
                  variant="outline"
                  className={`w-full justify-between border-edge/10 bg-white/[0.04] text-ink hover:bg-glass-10 ${
                    editForm.isActive ? "text-emerald-700 dark:text-emerald-200" : "text-copy-70"
                  }`}
                  onClick={() =>
                    setEditForm((current) =>
                      current
                        ? {
                            ...current,
                            isActive: !current.isActive,
                          }
                        : current,
                    )
                  }
                >
                  <span>{editForm.isActive ? "Enabled" : "Disabled"}</span>
                  <span className="text-xs text-copy-55">
                    Click to toggle
                  </span>
                </Button>
              </div>

              {canTransferEmail && (
                <div className="space-y-3 rounded-xl border border-amber-300/20 bg-amber-400/[0.04] p-4">
                  <div>
                    <Label htmlFor="transfer-email">Transfer email</Label>
                    <p className="mt-1 text-xs leading-5 text-copy-55">
                      Moves this account to a new login email. It becomes
                      unverified, is signed out everywhere, and a one-time code
                      is emailed to the new address. The password stays the
                      same.
                    </p>
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      id="transfer-email"
                      type="email"
                      value={transferEmail}
                      onChange={(event) => setTransferEmail(event.target.value)}
                      aria-invalid={Boolean(transferEmail.trim()) && !transferEmailValid}
                      placeholder="new-owner@example.com"
                      className="border-edge/10 bg-white/[0.04] text-ink placeholder:text-copy-35"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      className="border-amber-300/30 bg-transparent text-amber-700 dark:text-amber-100 hover:bg-amber-400/10"
                      disabled={!transferEmailValid || transferring || submitting}
                      onClick={() => setTransferConfirmOpen(true)}
                    >
                      Transfer email
                    </Button>
                  </div>
                  {transferEmail.trim() && !transferEmailValid && (
                    <p className="text-xs text-amber-700 dark:text-amber-200/80">
                      Enter a complete email address, e.g. name@company.com.
                    </p>
                  )}
                  {transferError && (
                    <p className="text-sm text-red-700 dark:text-red-300">{transferError}</p>
                  )}
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="border-edge/10 bg-transparent text-ink hover:bg-glass-10"
              onClick={() => setEditForm(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="bg-[#4EA3FF] text-white hover:bg-[#4098f7]"
              disabled={submitting || transferring}
              onClick={() => void handleSaveEdit()}
            >
              {submitting ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={transferConfirmOpen}
        onOpenChange={(open) => !transferring && setTransferConfirmOpen(open)}
      >
        <AlertDialogContent className="border-edge/10 bg-card dark:bg-[#0B183D] text-ink">
          <AlertDialogHeader>
            <AlertDialogTitle>Transfer this account&apos;s email?</AlertDialogTitle>
            <AlertDialogDescription className="text-copy-60">
              {editForm
                ? `${editForm.email} will be replaced by ${transferEmail.trim().toLowerCase()}. `
                : ""}
              Unsaved name, role or status edits in the previous dialog are discarded. The user is signed out everywhere and cannot log in until the new
              address is verified with the code we email to it (valid 24 hours).
              Pending reward claims that depend on the verified email will need
              to be re-verified.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={transferring}
              className="border-edge/10 bg-transparent text-ink hover:bg-glass-10"
            >
              Cancel
            </AlertDialogCancel>
            <Button
              type="button"
              className="bg-[#4EA3FF] text-white hover:bg-[#4098f7]"
              disabled={transferring || submitting}
              onClick={() => void handleTransferEmail()}
            >
              {transferring ? "Transferring..." : "Transfer and send code"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent className="border-edge/10 bg-card dark:bg-[#0B183D] text-ink">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete user?</AlertDialogTitle>
            <AlertDialogDescription className="text-copy-60">
              {deleteTarget
                ? `This will permanently remove ${deleteTarget.email}.`
                : "This action cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-edge/10 bg-transparent text-ink hover:bg-glass-10">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-[#C85A63] text-white hover:bg-[#b94b54]"
              onClick={() => void handleDeleteUser()}
            >
              {submitting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
