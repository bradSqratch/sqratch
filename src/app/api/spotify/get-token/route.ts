import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import axios from "axios";

export async function GET() {
  // 1) look for an existing token in the DB
  const existing = await prisma.spotifyToken.findFirst();
  const now = new Date();

  if (existing && existing.expiresAt > now) {
    // still valid
    return NextResponse.json({
      token: existing.token,
      expiresAt: existing.expiresAt,
    });
  }

  // 2) otherwise fetch a new one from Spotify
  const basic = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
  ).toString("base64");

  const resp = await axios.post(
    "https://accounts.spotify.com/api/token",
    new URLSearchParams({ grant_type: "client_credentials" }),
    {
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );

  const { access_token, expires_in } = resp.data as {
    access_token: string;
    expires_in: number;
  };

  // subtract 60s so we refresh a hair early
  const expiresAt = new Date(Date.now() + expires_in * 1000 - 60 * 1000);

  if (existing) {
    await prisma.spotifyToken.update({
      where: { id: existing.id },
      data: { token: access_token, expiresAt },
    });
  } else {
    await prisma.spotifyToken.create({
      data: { token: access_token, expiresAt },
    });
  }

  return NextResponse.json({ token: access_token, expiresAt });
}
