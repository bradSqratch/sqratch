"use client";

import { ReactNode } from "react";

export function AdminPageShell({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-6 p-6 text-white sm:p-8">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-2">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            {title}
          </h1>
          {description && (
            <p className="max-w-3xl text-sm leading-6 text-white/65">
              {description}
            </p>
          )}
        </div>
        {actions}
      </div>
      {children}
    </div>
  );
}
