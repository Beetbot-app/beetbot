import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * The currently-selected user profile (Netflix-style). Persisted to
 * localStorage so the choice survives relaunches; `null` means "no profile
 * chosen yet" which makes the app show the profile picker. Switching profiles
 * just sets this back to null (→ picker) or to another id.
 */
interface ProfileState {
  activeProfileId: number | null;
  setActiveProfile: (id: number | null) => void;
}

export const useProfileStore = create<ProfileState>()(
  persist(
    (set) => ({
      activeProfileId: null,
      setActiveProfile: (id) => set({ activeProfileId: id }),
    }),
    {
      name: 'beetbot.active_profile',
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
