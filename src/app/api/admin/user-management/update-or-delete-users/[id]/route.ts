import { NextResponse } from "next/server";
import { changeUserAccess, deleteUser, adminMutationError } from "@/lib/admin-user-mutations";
import { cleanupUnreferencedMedia } from "@/lib/media-cleanup";
import { getAdminContext, normalizeUserRole } from "@/lib/admin-auth";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getAdminContext();
  if (!session) {
    return NextResponse.json(
      { error: "Access denied. Admins only." },
      { status: 403 },
    );
  }

  const { id } = await params;

  let body: {
    name?: string;
    email?: string;
    role?: unknown;
    isActive?: boolean;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const role = normalizeUserRole(body.role);
  const isActive =
    typeof body.isActive === "boolean" ? body.isActive : undefined;

  if (!name || !email || !role || isActive === undefined) {
    return NextResponse.json(
      { error: "Name, email, role, and active status are required" },
      { status: 400 },
    );
  }

  try {
    const updated = await changeUserAccess({ actorId: session.userId, targetId: id, name, email, role, isActive });

    return NextResponse.json({
      data: {
        id: updated.id,
        name: updated.name,
        email: updated.email,
        role: updated.role,
        createdAt: updated.createdAt,
        isActive: updated.isActive,
        hasCreatorProfile: Boolean(updated.creatorProfile),
        brands: updated.brandMembers.map((member) => ({
          id: member.brand.id,
          name: member.brand.name,
          slug: member.brand.slug,
          membershipRole: member.role,
        })),
      },
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "ACTOR_NOT_ADMIN") return NextResponse.json({ error: "Administrator access is no longer active." }, { status: 403 });
    const conflict = adminMutationError(error);
    if (conflict) return NextResponse.json(conflict, { status: 409 });
    if (error instanceof Error && error.message === "USER_NOT_FOUND") {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    if (error instanceof Error && error.message === "EMAIL_CHANGE_NOT_ALLOWED") {
      return NextResponse.json(
        { error: "Use Transfer email to change a user's email address." },
        { status: 400 },
      );
    }

    const err = error as { code?: string; meta?: { target?: string[] } };

    if (err.code === "P2002" && err.meta?.target?.includes("email")) {
      return NextResponse.json(
        { error: "Email already in use" },
        { status: 409 },
      );
    }

    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getAdminContext();
  if (!session) {
    return NextResponse.json(
      { error: "Access denied. Admins only." },
      { status: 403 },
    );
  }

  const { id } = await params;

  try {
    const user = await deleteUser({ actorId: session.userId, targetId: id });

    if (user.imageUrl) {
      await cleanupUnreferencedMedia(user.imageUrl);
    }

    return NextResponse.json({});
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "ACTOR_NOT_ADMIN") return NextResponse.json({ error: "Administrator access is no longer active." }, { status: 403 });
    const conflict = adminMutationError(err);
    if (conflict) return NextResponse.json(conflict, { status: 409 });
    if (err instanceof Error && err.message === "USER_NOT_FOUND") return NextResponse.json({ error: "User not found" }, { status: 404 });
    const prismaErr = err as { code?: string };
    if (prismaErr.code === "P2034") {
      return NextResponse.json({ error: "Account activity changed during deletion. Review the account and retry or deactivate it." }, { status: 409 });
    }
    if (prismaErr.code === "P2003") {
      return NextResponse.json(
        {
          error:
            "Cannot delete user: dependent records exist. Deactivate the account instead.",
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: "Delete failed" }, { status: 500 });
  }
}
