import { dbClient } from '../lib/dbClient'

export async function getGoogleAuthUrl(): Promise<{ url: string; state: string }> {
  return await dbClient.functions.invoke<{ url: string; state: string }>('get-google-auth-url')
}

export async function getGoogleAccessToken(): Promise<string> {
  const body = await dbClient.functions.invoke<{ access_token: string }>('get-google-access-token')
  return body.access_token
}
