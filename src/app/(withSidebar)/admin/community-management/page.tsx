// src/app/admin/community-management/page.tsx
"use client";

import React, { useEffect, useState } from "react";
import axios from "axios";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";

type Community = {
  id: string;
  name: string;
  type: "BETTERMODE" | "GENERIC";
  createdAt: string;
};

export default function CommunitiesPage() {
  const [items, setItems] = useState<Community[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [form, setForm] = useState<{
    id?: string;
    name: string;
    type: "BETTERMODE" | "GENERIC";
  }>({ name: "", type: "GENERIC" });

  const fetchAll = async () => {
    try {
      const res = await axios.get<{ data: Community[] }>(
        "/api/admin/communities"
      );
      setItems(res.data.data);
    } catch {
      toast.error("Failed to load communities");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
  }, []);

  const openEdit = (c: Community) => {
    setForm({ id: c.id, name: c.name, type: c.type });
    setEditOpen(true);
  };

  const handleCreate = async () => {
    try {
      await axios.post("/api/admin/communities", {
        name: form.name,
        type: form.type,
      });
      toast.success("Community created");
      setCreateOpen(false);
      setForm({ name: "", type: "GENERIC" });
      fetchAll();
    } catch (e: any) {
      toast.error(e?.response?.data?.error || "Create failed");
    }
  };

  const handleUpdate = async () => {
    if (!form.id) return;
    try {
      await axios.patch(`/api/admin/communities/${form.id}`, {
        name: form.name,
        type: form.type,
      });
      toast.success("Updated");
      setEditOpen(false);
      fetchAll();
    } catch {
      toast.error("Update failed");
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this community?")) return;
    try {
      await axios.delete(`/api/admin/communities/${id}`);
      toast.success("Deleted");
      fetchAll();
    } catch {
      toast.error("Delete failed");
    }
  };

  return (
    <div className="min-h-screen p-8">
      <Card className="mx-auto max-w-6xl">
        <CardHeader className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Communities</h1>
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button className="bg-[#3b639a] text-xs px-2 py-1 leading-tight whitespace-normal text-center sm:text-base sm:px-4 sm:py-2 sm:whitespace-nowrap">
                <span className="block sm:hidden">
                  Create
                  <br />
                  Community
                </span>
                <span className="hidden sm:inline">Create Community</span>
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create Community</DialogTitle>
              </DialogHeader>
              <div className="space-y-3">
                <div>
                  <Label>Name</Label>
                  <Input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </div>
                <div>
                  <Label>Type</Label>
                  <Select
                    value={form.type}
                    onValueChange={(v) => setForm({ ...form, type: v as any })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Choose type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="BETTERMODE">
                        BetterMode (Zapier)
                      </SelectItem>
                      <SelectItem value="GENERIC">
                        Generic (Email Invite)
                      </SelectItem>
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
            <div className="text-center py-10 text-gray-500">Loading…</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Created At</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>{c.name}</TableCell>
                    <TableCell>{c.type}</TableCell>
                    <TableCell>
                      {new Date(c.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell className="space-x-2">
                      <Button size="sm" onClick={() => openEdit(c)}>
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => handleDelete(c.id)}
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

        <Dialog open={editOpen} onOpenChange={setEditOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit Community</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <Label>Name</Label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div>
                <Label>Type</Label>
                <Select
                  value={form.type}
                  onValueChange={(v) => setForm({ ...form, type: v as any })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Choose type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="BETTERMODE">
                      BetterMode (Zapier)
                    </SelectItem>
                    <SelectItem value="GENERIC">
                      Generic (Email Invite)
                    </SelectItem>
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
