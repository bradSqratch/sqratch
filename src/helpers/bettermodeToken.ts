// import prisma from "@/lib/prisma";

// export async function getBettermodeAccessToken(): Promise<string> {
//   const existing = await prisma.tokenStore.findUnique({
//     where: { service: "bettermode" },
//   });

//   const now = new Date();

//   if (existing && existing.expiresAt > now) {
//     return existing.token;
//   }

//   const networkId = process.env.BETTERMODE_NETWORK_ID!;
//   const clientId = process.env.BETTERMODE_CLIENT_ID!;
//   const clientSecret = process.env.BETTERMODE_CLIENT_SECRET!;

//   const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString(
//     "base64"
//   );

//   const graphqlQuery = {
//     query: `
//       query {
//         limitedToken(
//           context: NETWORK,
//           networkId: "${networkId}",
//           entityId: "${networkId}",
//         ) {
//           accessToken
//         }
//       }
//     `,
//   };

//   const response = await fetch(process.env.BETTERMODE_GRAPHQL_ENDPOINT!, {
//     method: "POST",
//     headers: {
//       "Content-Type": "application/json",
//       Authorization: `Basic ${basicAuth}`,
//     },
//     body: JSON.stringify(graphqlQuery),
//   });

//   const result = await response.json();

//   const accessToken = result?.data?.limitedToken?.accessToken;

//   if (!accessToken) {
//     console.error("Failed to get limitedToken:", result);
//     throw new Error("Failed to fetch Bettermode access token");
//   }

//   // Default is 30 days expiry – adjust as needed
//   const expiresAt = new Date(Date.now() + 29 * 24 * 60 * 60 * 1000);

//   await prisma.tokenStore.upsert({
//     where: { service: "bettermode" },
//     update: { token: accessToken, expiresAt },
//     create: { service: "bettermode", token: accessToken, expiresAt },
//   });

//   return accessToken;
// }
