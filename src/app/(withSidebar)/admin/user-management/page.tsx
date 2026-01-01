"use client";

import React, { useState, useEffect } from "react";
import axios from "axios";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Card, CardHeader, CardContent } from "@/components/ui/card";

type AdminUser = {
  id: string;
  name: string;
  email: string;
  role: "USER" | "ADMIN" | "EXTERNAL";
  points: number;
  createdAt: string;
};

export default function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    role: "ADMIN" as "USER" | "ADMIN" | "EXTERNAL",
  });
  const [editId, setEditId] = useState<string | null>(null);

  // Helper function to format date as "9/8/25, 1:00 AM"
  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const dateStr = date.toLocaleDateString("en-US", {
      year: "2-digit",
      month: "numeric",
      day: "numeric",
    });
    const timeStr = date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    return `${dateStr}, ${timeStr}`;
  };

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const res = await axios.get<{ data: AdminUser[] }>(
        "/api/admin/user-management/get-or-create-users"
      );
      setUsers(res.data.data);
    } catch {
      toast.error("Error loading users");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const resetForm = () => {
    setForm({ name: "", email: "", password: "", role: "ADMIN" });
    setEditId(null);
  };

  const handleCreate = async () => {
    const { name, email, password, role } = form;
    if (!name || !email || !password) {
      toast.error("All fields are required");
      return;
    }
    try {
      await axios.post("/api/admin/user-management/get-or-create-users", {
        name,
        email,
        password,
        role,
      });
      toast.success("Admin created. Verification email sent.");
      setCreateOpen(false);
      resetForm();
      fetchUsers();
    } catch (err: any) {
      if (err.response?.status === 409) {
        toast.error("Email already in use");
      } else {
        toast.error("Failed to create");
      }
    }
  };

  const openEdit = (u: AdminUser) => {
    setEditId(u.id);
    setForm({ name: u.name, email: u.email, password: "", role: u.role });
    setEditOpen(true);
  };

  const handleUpdate = async () => {
    if (!editId) return;
    const { name, email, role } = form;
    if (!name || !email) {
      toast.error("Name & email required");
      return;
    }
    try {
      await axios.patch(
        `/api/admin/user-management/update-or-delete-users/${editId}`,
        {
          name,
          email,
          role,
        }
      );
      toast.success("Updated");
      setEditOpen(false);
      resetForm();
      fetchUsers();
    } catch (err: any) {
      if (err.response?.status === 409) {
        toast.error("Email already in use");
      } else {
        toast.error("Update failed");
      }
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this user?")) return;
    try {
      await axios.delete(
        `/api/admin/user-management/update-or-delete-users/${id}`
      );
      toast.success("Deleted");
      fetchUsers();
    } catch {
      toast.error("Delete failed");
    }
  };

  return (
    <div className="min-h-screen p-8">
      <Card className="mx-auto max-w-6xl">
        <CardHeader className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Admin Users</h1>

          {/* Create Admin Dialog */}
          <Dialog
            open={createOpen}
            onOpenChange={(open) => {
              setCreateOpen(open);
              if (open) resetForm(); // Clear form fields when opening the Create dialog
            }}
          >
            <DialogTrigger asChild>
              <Button
                onClick={() => {
                  resetForm(); // Extra safety, though not strictly necessary with onOpenChange
                }}
                className="bg-[#3E93DE] text-white"
              >
                Create User
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[480px] bg-[#05050f]/35 text-white border border-white/10 backdrop-blur-md">
              <DialogHeader>
                <DialogTitle>Create User</DialogTitle>
                <DialogDescription>
                  All fields required, email must be unique.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div>
                  <Label htmlFor="create-name">Name</Label>
                  <Input
                    id="create-name"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="create-email">Email</Label>
                  <Input
                    id="create-email"
                    type="email"
                    value={form.email}
                    onChange={(e) =>
                      setForm({ ...form, email: e.target.value })
                    }
                  />
                </div>
                <div>
                  <Label htmlFor="create-password">Password</Label>
                  <Input
                    id="create-password"
                    type="password"
                    value={form.password}
                    onChange={(e) =>
                      setForm({ ...form, password: e.target.value })
                    }
                  />
                </div>
                <div>
                  <Label htmlFor="create-role">Role</Label>
                  <Select
                    onValueChange={(v) =>
                      setForm({ ...form, role: v as "USER" | "ADMIN" })
                    }
                    value={form.role}
                  >
                    <SelectTrigger id="create-role" className="w-full">
                      <SelectValue placeholder="Select role" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="EXTERNAL">EXTERNAL</SelectItem>
                      <SelectItem value="USER">USER</SelectItem>
                      <SelectItem value="ADMIN">ADMIN</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <DialogFooter>
                <DialogClose asChild>
                  <Button className="w-full" onClick={handleCreate}>
                    Create
                  </Button>
                </DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardHeader>

        <CardContent className="overflow-x-auto">
          {loading ? (
            <div className="w-full text-center py-10 text-gray-500">
              Loading…
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Sqratch Points</TableHead>
                  <TableHead>Created At</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell>{u.name}</TableCell>
                    <TableCell>{u.email}</TableCell>
                    <TableCell>{u.role}</TableCell>
                    <TableCell>{u.points}</TableCell>
                    <TableCell>{formatDate(u.createdAt)}</TableCell>
                    <TableCell className="space-x-2">
                      <Button size="sm" onClick={() => openEdit(u)}>
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => handleDelete(u.id)}
                      >
                        Delete
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>

        {/* Edit Dialog */}
        <Dialog open={editOpen} onOpenChange={setEditOpen}>
          <DialogContent className="sm:max-w-[480px] bg-[#05050f]/35 text-white border border-white/10 backdrop-blur-md">
            <DialogHeader>
              <DialogTitle>Edit Admin User</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <Label htmlFor="edit-name">Name</Label>
                <Input
                  id="edit-name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="edit-email">Email</Label>
                <Input
                  id="edit-email"
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="edit-role">Role</Label>
                <Select
                  onValueChange={(v) =>
                    setForm({ ...form, role: v as "USER" | "ADMIN" })
                  }
                  value={form.role}
                >
                  <SelectTrigger id="edit-role" className="w-full">
                    <SelectValue placeholder="Select role" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="EXTERNAL">EXTERNAL</SelectItem>
                    <SelectItem value="ADMIN">ADMIN</SelectItem>
                    <SelectItem value="USER">USER</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button className="w-full" onClick={handleUpdate}>
                  Save Changes
                </Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Card>
    </div>
  );
}
