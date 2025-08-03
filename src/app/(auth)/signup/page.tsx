"use client";
import Link from "next/link";
import React, { useEffect } from "react";
import { useRouter } from "next/navigation";
import axios from "axios";
import { useSession, signIn } from "next-auth/react";
import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export default function SignupPage() {
  const router = useRouter();

  const { data: session, status } = useSession(); // Fetch session data

  const [user, setUser] = React.useState({
    email: "",
    password: "",
    name: "",
  });
  const [buttonDisabled, setButtonDisabled] = React.useState(false);
  const [loading, setLoading] = React.useState(false);

  const onSignup = async () => {
    try {
      setLoading(true);
      const response = await axios.post("/api/users/signup", {
        ...user,
      });
      console.log("Signup success", response.data);
      toast.success("Success", {
        description: "Signup successful!",
      });
      // Normal flow: redirect to login page
      router.push("/login");
    } catch (error: any) {
      console.log("Signup failed", error.message);
      toast.error("Error", {
        description: error.message,
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (
      user.email.length > 0 &&
      user.password.length > 0 &&
      user.name.length > 0
    ) {
      setButtonDisabled(false);
    } else {
      setButtonDisabled(true);
    }
  }, [user]);

  return (
    <section className="position-relative bg-[url('/assets/homepage/home_bg.jpeg')] bg-center bg-cover">
      <div className="absolute inset-0 bg-black opacity-75"></div>
      <div className="container-fluid relative">
        <div className="grid grid-cols-1">
          <div className="lg:col-span-4">
            <div className="flex flex-col min-h-screen md:px-12 py-12 px-3">
              {/* <!-- Start Logo --> */}
              <div className="text-center mx-auto">
                <Link href="/">
                  <div className="flex justify-center mb-4 bg-transparent">
                    <Avatar
                      style={{
                        height: "4rem",
                        width: "12rem",
                        padding: "0.3rem",
                        borderRadius: "2rem",
                      }}
                    >
                      <AvatarImage src="/sqratchLogo.png" alt="Logo" />
                      <AvatarFallback>SQRATCH</AvatarFallback>
                    </Avatar>
                  </div>
                </Link>
              </div>
              {/* <!-- End Logo --> */}

              {/* <!-- Start Content --> */}
              <div className="my-auto">
                <div className="grid grid-cols-1 w-full max-w-sm m-auto px-6 py-4">
                  <Card className="w-[350px]">
                    <CardHeader>
                      <CardTitle className="text-3xl text-center">
                        {loading ? "Processing" : "Signup"}
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <form>
                        <div className="grid w-full items-center gap-4">
                          <div className="flex flex-col space-y-1.5">
                            <Label htmlFor="name">Name</Label>
                            <Input
                              className="p-2 border border-gray-300 rounded-lg mb-4 focus:outline-none focus:border-gray-600 text-black"
                              id="name"
                              type="text"
                              autoComplete="name"
                              value={user.name}
                              onChange={(e) =>
                                setUser({ ...user, name: e.target.value })
                              }
                              placeholder="Name"
                            />
                          </div>
                          <div className="flex flex-col space-y-1.5">
                            <Label htmlFor="email">Email</Label>
                            <Input
                              className="p-2 border border-gray-300 rounded-lg mb-4 focus:outline-none focus:border-gray-600 text-black"
                              id="email"
                              type="text"
                              autoComplete="email"
                              value={user.email}
                              onChange={(e) =>
                                setUser({ ...user, email: e.target.value })
                              }
                              placeholder="Email"
                            />
                          </div>
                          <div className="flex flex-col space-y-1.5">
                            <Label htmlFor="password">Password</Label>
                            <Input
                              className="p-2 border border-gray-300 rounded-lg mb-4 focus:outline-none focus:border-gray-600 text-black"
                              id="password"
                              type="password"
                              autoComplete="current-password"
                              value={user.password}
                              onChange={(e) =>
                                setUser({ ...user, password: e.target.value })
                              }
                              placeholder="Password"
                            />
                          </div>
                        </div>
                      </form>
                    </CardContent>
                    <CardFooter className="flex flex-col">
                      <Button
                        onClick={onSignup}
                        disabled={buttonDisabled || loading}
                        className="w-full bg-green-600 text-white rounded-full py-3 hover:bg-green-700 transition-colors animate-none hover:animate-bounceHover"
                      >
                        {loading ? "Signing up..." : "Signup"}
                      </Button>
                      <Button
                        variant="link"
                        asChild
                        className="text-blue-500 hover:underline mt-5"
                      >
                        <Link href="/login">
                          Already have an account? Login here
                        </Link>
                      </Button>
                    </CardFooter>
                  </Card>
                </div>
              </div>
              {/* <!-- End Content --> */}

              {/* <!-- Start Footer --> */}
              <div className="text-center">
                <p className="text-gray-400">
                  © {new Date().getFullYear()} SQRATCH. All rights reserved.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
