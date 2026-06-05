import { create } from 'zustand';
import type { Call } from './api';

interface CallStore {
  userId: string | null;
  callbackPhone: string | null;
  activeCall: Call | null;
  callHistory: Call[];
  setUserId: (id: string | null) => void;
  setCallbackPhone: (phone: string | null) => void;
  setActiveCall: (call: Call | null) => void;
  setCallHistory: (calls: Call[]) => void;
  patchCall: (callId: string, patch: Partial<Call>) => void;
}

export const useCallStore = create<CallStore>((set) => ({
  userId: null,
  callbackPhone: null,
  activeCall: null,
  callHistory: [],
  setUserId: (id) => set({ userId: id ?? null }),
  setCallbackPhone: (phone) => set({ callbackPhone: phone ?? null }),
  setActiveCall: (call) => set({ activeCall: call }),
  setCallHistory: (calls) => set({ callHistory: calls }),
  patchCall: (callId, patch) =>
    set((state) => ({
      activeCall:
        state.activeCall?.id === callId
          ? { ...state.activeCall, ...patch }
          : state.activeCall,
      callHistory: state.callHistory.map((c) =>
        c.id === callId ? { ...c, ...patch } : c
      ),
    })),
}));
