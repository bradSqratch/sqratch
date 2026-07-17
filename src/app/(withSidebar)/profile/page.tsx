"use client";

import { useEffect, useRef, useState } from "react";
import {
  deleteUploadedAsset,
  fetchJson,
  getErrorMessage,
} from "@/components/experience/client-utils";
import { PageCard } from "@/components/experience/experience-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { signOut } from "next-auth/react";

type UserProfile = {
  id: string;
  name: string | null;
  email: string;
  imageUrl: string | null;
};

export default function ProfilePage() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [name, setName] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingAvatarFile, setPendingAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);

      try {
        const data = await fetchJson<UserProfile>("/api/user/profile");
        setProfile(data);
        setName(data.name || "");
        setImageUrl(data.imageUrl || "");
      } catch (loadError) {
        setError(getErrorMessage(loadError, "Failed to load profile."));
      } finally {
        setLoading(false);
      }
    }

    void load();
  }, []);

  useEffect(() => {
    return () => {
      if (avatarPreview) {
        URL.revokeObjectURL(avatarPreview);
      }
    };
  }, [avatarPreview]);

  async function handleUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    if (avatarPreview) {
      URL.revokeObjectURL(avatarPreview);
    }

    setPendingAvatarFile(file);
    setAvatarPreview(URL.createObjectURL(file));
    setError(null);
    event.target.value = "";
  }

  async function handleSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);

    let nextImageUrl = imageUrl;
    let uploadedImageUrl: string | null = null;

    try {
      if (pendingAvatarFile) {
        const formData = new FormData();
        formData.append("file", pendingAvatarFile);

        const uploadResult = await fetchJson<{ fileUrl: string }>(
          "/api/uploads/user-avatar",
          {
            method: "POST",
            body: formData,
          },
        );

        nextImageUrl = uploadResult.fileUrl;
        uploadedImageUrl = uploadResult.fileUrl;
      }

      const updated = await fetchJson<UserProfile>("/api/user/profile", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name,
          imageUrl: nextImageUrl,
        }),
      });
      setProfile(updated);
      setName(updated.name || "");
      setImageUrl(updated.imageUrl || "");
      setPendingAvatarFile(null);
      if (avatarPreview) {
        URL.revokeObjectURL(avatarPreview);
        setAvatarPreview(null);
      }
    } catch (saveError) {
      if (uploadedImageUrl) {
        await deleteUploadedAsset(uploadedImageUrl);
      }
      setError(getErrorMessage(saveError, "Failed to update profile."));
    } finally {
      setSaving(false);
    }
  }

  async function handleChangePassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPasswordSaving(true);
    setPasswordError(null);
    setPasswordSuccess(null);

    if (!currentPassword || !newPassword || !confirmPassword) {
      setPasswordError("All password fields are required.");
      setPasswordSaving(false);
      return;
    }

    if (newPassword !== confirmPassword) {
      setPasswordError("New password and confirmation do not match.");
      setPasswordSaving(false);
      return;
    }

    try {
      await fetchJson("/api/user/change-password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          currentPassword,
          newPassword,
          confirmPassword,
        }),
      });

      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      await signOut({ callbackUrl: "/login" });
    } catch (saveError) {
      setPasswordError(
        getErrorMessage(saveError, "Failed to change password."),
      );
    } finally {
      setPasswordSaving(false);
    }
  }

  return (
    <div className="min-h-screen p-8 text-white">
      <h1 className="text-3xl font-semibold">Profile</h1>
      <p className="mt-2 text-sm text-white/65">
        Manage your display name and profile image.
      </p>

      <PageCard className="mt-6">
        {loading ? (
          <p className="text-sm text-white/65">Loading profile...</p>
        ) : (
          <form onSubmit={handleSave} className="space-y-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
              <div className="h-24 w-24 overflow-hidden rounded-full border border-white/10 bg-white/5">
                {avatarPreview || imageUrl ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={avatarPreview || imageUrl}
                      alt={profile?.name || "Profile"}
                      className="h-full w-full object-cover"
                    />
                  </>
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-white/40">
                    No image
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".png,.jpg,.jpeg,.webp"
                  onChange={handleUpload}
                  disabled={saving}
                  className="hidden"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={saving}
                  className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
                >
                  {pendingAvatarFile ? "Image selected" : "Upload profile image"}
                </Button>
                <p className="text-xs text-white/45">
                  PNG, JPG, JPEG, WEBP up to 5 MB.
                </p>
                {pendingAvatarFile ? (
                  <p className="text-xs text-white/45">
                    Pending file: {pendingAvatarFile.name}. Save profile to upload and apply it.
                  </p>
                ) : null}
              </div>
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm text-white/70">Name</label>
                <Input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="border-white/10 bg-black/20 text-white"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm text-white/70">Email</label>
                <Input
                  value={profile?.email || ""}
                  disabled
                  className="border-white/10 bg-black/20 text-white/60"
                />
              </div>
            </div>

            {error && <p className="text-sm text-red-300">{error}</p>}

            <Button
              type="submit"
              disabled={saving}
              className="rounded-full border border-white bg-white text-black"
            >
              {saving ? "Saving..." : "Save profile"}
            </Button>
          </form>
        )}
      </PageCard>

      <PageCard className="mt-6">
        <h2 className="text-xl font-semibold">Change password</h2>
        <p className="mt-2 text-sm text-white/60">
          Use a strong password with at least 8 characters, including a letter and a number.
        </p>

        <form onSubmit={handleChangePassword} className="mt-5 space-y-4">
          <div className="grid gap-5 lg:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm text-white/70">Current password</label>
              <Input
                type="password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                className="border-white/10 bg-black/20 text-white"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm text-white/70">New password</label>
              <Input
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                className="border-white/10 bg-black/20 text-white"
              />
            </div>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm text-white/70">Confirm new password</label>
              <Input
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                className="border-white/10 bg-black/20 text-white"
              />
            </div>
          </div>

          {passwordError && (
            <p className="text-sm text-red-300">{passwordError}</p>
          )}
          {passwordSuccess && (
            <p className="text-sm text-emerald-200">{passwordSuccess}</p>
          )}

          <Button
            type="submit"
            disabled={passwordSaving}
            className="rounded-full border border-white bg-white text-black"
          >
            {passwordSaving ? "Updating..." : "Update password"}
          </Button>
        </form>
      </PageCard>
    </div>
  );
}
