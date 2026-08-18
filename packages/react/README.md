# Contour React bindings

`@contour/react` provides TanStack Query hooks over an `ArcNameClient`. It is a
workspace package and is not currently published to the public npm registry.

```bash
pnpm install --frozen-lockfile
pnpm --filter @contour/react build
```

Wrap the application with both TanStack Query and the Contour client provider:

```tsx
"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ArcNameProvider, useArcName } from "@contour/react";
import type { ArcNameClient } from "@contour/sdk";

const queryClient = new QueryClient();

export function ContourProviders({
  client,
  children,
}: {
  client: ArcNameClient;
  children: React.ReactNode;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <ArcNameProvider client={client}>{children}</ArcNameProvider>
    </QueryClientProvider>
  );
}

export function NameOwner({ label }: { label: string }) {
  const name = useArcName(label);
  if (name.isPending) return <span>Reading Arc…</span>;
  if (name.isError) return <span>Registry read failed.</span>;
  return <span>{name.data.registrant ?? "Available"}</span>;
}
```

Available hooks are `useArcName`, `useArcReverse`, `useRegistrationQuote`, and
`useArcListing`. They preserve RPC errors as errors and never treat an unverified
reverse record as identity.
