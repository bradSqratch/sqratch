"use client";

import { useEffect, useMemo, useState } from "react";
import {
  fetchJson,
  getErrorMessage,
} from "@/components/experience/client-utils";
import { Button } from "@/components/ui/button";
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
    return <span className="text-sm text-white/35">None</span>;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {memberships.map((label) => (
        <span
          key={label}
          className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs text-white/75"
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

  async function handleDeleteUser() {
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
    <div className="space-y-6 p-6 text-white sm:p-8">
      <div className="rounded-[28px] border border-[#28456C] bg-[#0B183D]/90 px-6 py-7 shadow-[0_20px_80px_rgba(0,0,0,0.35)] sm:px-8">
        <div className="flex flex-col gap-4 border-b border-white/10 pb-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <h1 className="text-4xl font-semibold tracking-tight">
              Admin Users
            </h1>
            <p className="text-sm text-white/60">
              Manage users in the legacy table view with live search and full
              edit controls.
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by name or email"
              className="h-10 w-full border-white/10 bg-white/[0.04] text-white placeholder:text-white/35 sm:w-72"
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

        {error && (
          <div className="mt-5 rounded-xl border border-red-400/25 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        )}

        <div className="mt-6 overflow-hidden rounded-2xl border border-white/10">
          <Table className="min-w-[1040px] bg-transparent text-white">
            <TableHeader className="[&_tr]:border-white/10">
              <TableRow className="border-white/10 bg-white/[0.02] hover:bg-white/[0.02]">
                <TableHead className="px-4 py-4 text-sm font-medium text-white/75">
                  Name
                </TableHead>
                <TableHead className="py-4 text-sm font-medium text-white/75">
                  Email
                </TableHead>
                <TableHead className="py-4 text-sm font-medium text-white/75">
                  Role
                </TableHead>
                <TableHead className="py-4 text-sm font-medium text-white/75">
                  Creator/Brand
                </TableHead>
                <TableHead className="py-4 text-sm font-medium text-white/75">
                  Created At
                </TableHead>
                <TableHead className="py-4 text-sm font-medium text-white/75">
                  Status
                </TableHead>
                <TableHead className="py-4 text-sm font-medium text-white/75">
                  Actions
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="[&_tr:last-child]:border-b-0">
              {loading ? (
                <TableRow className="border-white/10 hover:bg-transparent">
                  <TableCell
                    colSpan={7}
                    className="px-4 py-8 text-center text-white/60"
                  >
                    Loading users...
                  </TableCell>
                </TableRow>
              ) : users.length === 0 ? (
                <TableRow className="border-white/10 hover:bg-transparent">
                  <TableCell
                    colSpan={7}
                    className="px-4 py-8 text-center text-white/60"
                  >
                    No users found.
                  </TableCell>
                </TableRow>
              ) : (
                users.map((user) => (
                  <TableRow
                    key={user.id}
                    className="border-white/10 text-white/90 hover:bg-white/[0.03]"
                  >
                    <TableCell className="px-4 py-4 text-base font-medium text-white">
                      {user.name || "Unnamed user"}
                    </TableCell>
                    <TableCell className="py-4 text-sm text-white/80">
                      {user.email}
                    </TableCell>
                    <TableCell className="py-4 text-sm text-white/80">
                      {user.role}
                    </TableCell>
                    <TableCell className="py-4">
                      <MembershipBadges user={user} />
                    </TableCell>
                    <TableCell className="py-4 text-sm text-white/80">
                      {formatDateTime(user.createdAt)}
                    </TableCell>
                    <TableCell className="py-4">
                      <span
                        className={`rounded-full border px-3 py-1 text-xs ${
                          user.isActive
                            ? "border-emerald-400/25 bg-emerald-500/10 text-emerald-200"
                            : "border-white/10 bg-white/[0.04] text-white/65"
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
                          className="h-8 rounded-xl border-[#35507D] bg-transparent px-5 text-white hover:bg-white/[0.06] hover:text-white"
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
        <DialogContent className="border-white/10 bg-[#0B183D] text-white sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Create User</DialogTitle>
            <DialogDescription className="text-white/60">
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
                className="border-white/10 bg-white/[0.04] text-white"
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
                className="border-white/10 bg-white/[0.04] text-white"
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
                className="border-white/10 bg-white/[0.04] text-white"
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
                className="h-10 rounded-md border border-white/10 bg-white/[0.04] px-3 text-sm text-white outline-none"
              >
                {roles.map((role) => (
                  <option key={role} value={role} className="text-black">
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
              className="border-white/10 bg-transparent text-white hover:bg-white/10"
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
        <DialogContent className="border-white/10 bg-[#0B183D] text-white sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Edit User</DialogTitle>
            <DialogDescription className="text-white/60">
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
                  className="border-white/10 bg-white/[0.04] text-white"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="edit-email">Email</Label>
                <Input
                  id="edit-email"
                  type="email"
                  value={editForm.email}
                  onChange={(event) =>
                    setEditForm((current) =>
                      current
                        ? {
                            ...current,
                            email: event.target.value,
                          }
                        : current,
                    )
                  }
                  className="border-white/10 bg-white/[0.04] text-white"
                />
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
                  className="h-10 rounded-md border border-white/10 bg-white/[0.04] px-3 text-sm text-white outline-none"
                >
                  {roles.map((role) => (
                    <option key={role} value={role} className="text-black">
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
                  className={`w-full justify-between border-white/10 bg-white/[0.04] text-white hover:bg-white/10 ${
                    editForm.isActive ? "text-emerald-200" : "text-white/70"
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
                  <span className="text-xs text-white/55">
                    Click to toggle
                  </span>
                </Button>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="border-white/10 bg-transparent text-white hover:bg-white/10"
              onClick={() => setEditForm(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="bg-[#4EA3FF] text-white hover:bg-[#4098f7]"
              disabled={submitting}
              onClick={() => void handleSaveEdit()}
            >
              {submitting ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent className="border-white/10 bg-[#0B183D] text-white">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete user?</AlertDialogTitle>
            <AlertDialogDescription className="text-white/60">
              {deleteTarget
                ? `This will permanently remove ${deleteTarget.email}.`
                : "This action cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-white/10 bg-transparent text-white hover:bg-white/10">
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
