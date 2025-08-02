import { Toaster } from "@/components/ui/sonner";

export const metadata = {
  title: "Signup - SQRATCH",
};

export default function SignupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      {children}
      <Toaster richColors />
    </>
  );
}
