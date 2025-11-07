import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface AuthState {
  isAuthenticated: boolean
  user: {
    email: string
    role: string
    id: string
  } | null
  accessToken: string | null
  refreshToken: string | null
  login: (email: string, password: string) => Promise<void>
  logout: () => void
  setTokens: (accessToken: string, refreshToken: string) => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      isAuthenticated: false,
      user: null,
      accessToken: null,
      refreshToken: null,

      login: async (email: string, password: string) => {
        // Mock authentication - credentials: admin / admin
        const VALID_USERNAME = 'admin'
        const VALID_PASSWORD = 'admin'

        // Trim whitespace from inputs
        const cleanEmail = email.trim()
        const cleanPassword = password.trim()

        // Simulate API call delay
        await new Promise(resolve => setTimeout(resolve, 500))

        // Validate credentials
        if (cleanEmail !== VALID_USERNAME || cleanPassword !== VALID_PASSWORD) {
          throw new Error('Invalid username or password')
        }

        // Mock tokens
        const mockAccessToken = 'mock-access-token-' + Date.now()
        const mockRefreshToken = 'mock-refresh-token-' + Date.now()

        set({
          isAuthenticated: true,
          accessToken: mockAccessToken,
          refreshToken: mockRefreshToken,
          user: {
            email: VALID_USERNAME,
            role: 'admin',
            id: 'admin-001',
          },
        })
      },

      logout: () => {
        set({
          isAuthenticated: false,
          user: null,
          accessToken: null,
          refreshToken: null,
        })
      },

      setTokens: (accessToken: string, refreshToken: string) => {
        set({ accessToken, refreshToken })
      },
    }),
    {
      name: 'dlp-auth-v2',
    }
  )
)
