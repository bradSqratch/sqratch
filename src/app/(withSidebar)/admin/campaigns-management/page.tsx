"use client";

import React, { useEffect, useState } from "react";
import axios from "axios";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export default function CampaignsPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [editOpen, setEditOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [form, setForm] = useState({
    id: "",
    name: "",
    description: "",
    inviteUrl: "",
  });

  type Campaign = {
    id: string;
    name: string;
    description?: string;
    inviteUrl: string;
    createdAt: string;
  };

  const resetForm = () => {
    setForm({ id: "", name: "", description: "", inviteUrl: "" });
  };

  const fetchCampaigns = async () => {
    try {
      const res = await axios.get<{ data: Campaign[] }>(
        "/api/admin/get-all-campaigns"
      );
      setCampaigns(res.data.data);
    } catch (err) {
      toast.error("Failed to load campaigns");
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this campaign?")) return;
    try {
      setBlocking(true);
      await axios.delete(
        `/api/admin/campaign-management/update-or-delete-campaign/${id}`
      );
      toast.success("Campaign deleted");
      await fetchCampaigns();
    } catch {
      toast.error("Delete failed");
    } finally {
      setBlocking(false);
    }
  };

  const openEdit = (c: Campaign) => {
    setForm({
      id: c.id,
      name: c.name,
      description: c.description || "",
      inviteUrl: c.inviteUrl,
    });
    setEditOpen(true);
  };

  const handleUpdate = async () => {
    const { id, name, description, inviteUrl } = form;
    if (!name || !inviteUrl) {
      toast.error("Name and Invite URL are required");
      return;
    }
    try {
      setBlocking(true);
      await axios.patch(
        `/api/admin/campaign-management/update-or-delete-campaign/${id}`,
        {
          name,
          description,
          inviteUrl,
        }
      );
      toast.success("Updated");
      setEditOpen(false);
      await fetchCampaigns();
    } catch (err: any) {
      if (err.response?.status === 409) {
        toast.error("Duplicate invite URL");
      } else {
        toast.error("Update failed");
      }
    } finally {
      setBlocking(false);
    }
  };

  const handleCreate = async () => {
    const { name, description, inviteUrl } = form;
    if (!name) {
      toast.error("Name is required");
      return;
    }
    try {
      setBlocking(true);
      await axios.post("/api/admin/campaign-management/create-campaign", {
        name,
        description,
        inviteUrl,
      });
      toast.success("Campaign created");
      setCreateOpen(false);
      resetForm();
      await fetchCampaigns();
    } catch (err: any) {
      if (err.response?.status === 409) {
        toast.error("Name or Invite URL already exists");
      } else {
        toast.error("Failed to create campaign");
      }
    } finally {
      setBlocking(false);
    }
  };

  useEffect(() => {
    if (status === "loading") return;
    if (!session || session.user.role !== "ADMIN") {
      router.push("/dashboard");
    } else {
      fetchCampaigns();
    }
  }, [status, session, router]);

  return (
    <div className="min-h-screen p-8 relative">
      {blocking && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 backdrop-blur-sm">
          <div className="text-white text-lg font-semibold">Processing…</div>
        </div>
      )}

      <Card className="mx-auto max-w-6xl">
        <CardHeader className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Campaigns</h1>
          <Dialog
            open={createOpen}
            onOpenChange={(open) => {
              setCreateOpen(open);
              if (open) resetForm();
            }}
          >
            <DialogTrigger asChild>
              <Button>Create Campaign</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create Campaign</DialogTitle>
                <DialogDescription>All fields required</DialogDescription>
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
                  <Label htmlFor="create-desc">Description</Label>
                  <Input
                    id="create-desc"
                    value={form.description}
                    onChange={(e) =>
                      setForm({ ...form, description: e.target.value })
                    }
                  />
                </div>
                <div>
                  <Label htmlFor="create-url">Invite URL</Label>
                  <Input
                    id="create-url"
                    value={form.inviteUrl}
                    onChange={(e) =>
                      setForm({ ...form, inviteUrl: e.target.value })
                    }
                  />
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
          ) : campaigns.length === 0 ? (
            <div className="text-center py-10 text-gray-500">
              No campaigns found.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Invite URL</TableHead>
                  <TableHead>Created At</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {campaigns.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <Link
                        href={`/admin/qr-management?campaignId=${c.id}`}
                        className="text-blue-600 underline hover:opacity-80"
                      >
                        {c.name}
                      </Link>
                    </TableCell>
                    <TableCell>{c.description || "—"}</TableCell>
                    <TableCell className="max-w-xs truncate text-blue-600">
                      {c.inviteUrl}
                    </TableCell>
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
              <DialogTitle>Edit Campaign</DialogTitle>
              <DialogDescription>
                Edit and save changes to the campaign.
              </DialogDescription>
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
                <Label htmlFor="edit-desc">Description</Label>
                <Input
                  id="edit-desc"
                  value={form.description}
                  onChange={(e) =>
                    setForm({ ...form, description: e.target.value })
                  }
                />
              </div>
              <div>
                <Label htmlFor="edit-url">Invite URL</Label>
                <Input
                  id="edit-url"
                  value={form.inviteUrl}
                  onChange={(e) =>
                    setForm({ ...form, inviteUrl: e.target.value })
                  }
                />
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
