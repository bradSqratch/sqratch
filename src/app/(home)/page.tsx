"use client";

import React, { useEffect, useState, useCallback } from "react";
import axios from "axios";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type SongRequest = {
  id: string;
  name: string;
  song: string;
  createdAt: string;
};

export default function GuestQueuePage() {
  const [queue, setQueue] = useState<SongRequest[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  const fetchQueue = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get<{ data: SongRequest[] }>(
        "/api/public-song-requests/get-approved-songs?status=APPROVED"
      );
      setQueue(res.data.data);
    } catch (err) {
      console.error("Failed to load queue:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchQueue();
    const interval = setInterval(fetchQueue, 30_000);
    return () => clearInterval(interval);
  }, [fetchQueue]);

  return (
    <div
      className="min-h-screen flex flex-col relative
       bg-[url('/assets/homepage/home_bg.jpeg')]
       bg-cover bg-center"
    >
      {/* Header */}
      <header className="flex items-center justify-between p-4 bg-black shadow">
        <Link href="/">
          <img
            src="/sqratchLogo.png"
            alt="SQRATCH Logo"
            className="h-10 w-auto"
          />
        </Link>
        <Link href="/login">
          <Button
            variant="ghost"
            className="text-amber-100 border-amber-100 border-1 hover:bg-amber-100"
          >
            Admin Login
          </Button>
        </Link>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex items-center justify-center p-8">
        <Card className="w-full max-w-4xl bg-[#ffffff] shadow-2xl z-10">
          <CardHeader>
            <CardTitle>Current Karaoke Queue</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableCaption>
                {loading
                  ? "Loading..."
                  : queue.length
                  ? `Updated at ${new Date().toLocaleTimeString()}`
                  : "No songs in queue."}
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Position</TableHead>
                  <TableHead>Song Title</TableHead>
                  <TableHead>Requested By</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {queue.map((item, idx) => (
                  <TableRow key={item.id}>
                    <TableCell>{idx + 1}</TableCell>
                    <TableCell>{item.song}</TableCell>
                    <TableCell>{item.name.split(" ")[0]}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
          <CardFooter className="flex justify-center mt-5">
            <Link href="/new-song-request">
              <Button className="bg-[#202020] text-xl py-5 px-5">
                Request a Song
              </Button>
            </Link>
          </CardFooter>
        </Card>
      </main>
    </div>
  );
}
