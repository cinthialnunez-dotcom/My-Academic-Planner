import { useState, useEffect, useMemo, UIEvent, useRef } from 'react';
import { CalendarEvent, CalendarLayer, CalendarView, TodoItem, LayerConfig, ScheduledWorkSession } from './types';
import { LayerToggles } from './components/LayerToggles';
import { EventModal } from './components/EventModal';
import { EventDetailModal } from './components/EventDetailModal';
import { CalendarMonthView } from './components/CalendarMonthView';
import { CalendarWeekView } from './components/CalendarWeekView';
import { CalendarDayView } from './components/CalendarDayView';
import { DEFAULT_EVENTS, formatDateString, formatMonthYear, loadTasksV1, saveTasksV1 } from './utils';
import { ChevronLeft, ChevronRight, Plus, Calendar, RefreshCw, ClipboardList, Settings, Check, AlertTriangle, LogIn, LogOut, Download, Cloud } from 'lucide-react';
import { BuildTodoModal } from './components/BuildTodoModal';
import { ViewTodoModal } from './components/ViewTodoModal';
import { SettingsModal } from './components/SettingsModal';
import confetti from 'canvas-confetti';

// Firebase integrations
import { signInWithPopup, signInWithRedirect, signOut, onAuthStateChanged, User } from 'firebase/auth';
import { 
  auth, 
  googleProvider, 
  isFirebaseConfigured, 
  getUserConfig, 
  saveUserConfig, 
  getEvents, 
  getTodos, 
  saveEvent, 
  deleteEvent as firestoreDeleteEvent, 
  saveTodo, 
  deleteTodo as firestoreDeleteTodo, 
  batchMigrateLocalToFirestore,
  getPlannerData,
  savePlannerData,
  subscribePlannerData,
  cleanUndefined,
  PlannerData,
  triggerQuotaOffline
} from './firebase';

export default function App() {
  // Load events from LocalStorage or fallback to DEFAULT_EVENTS
  const [events, setEvents] = useState<CalendarEvent[]>(() => {
    const keysToCheck = [
      'calendarEvents',
      'layer_calendar_events',
      'events',
      'academicPlannerEvents'
    ];
    
    const allEventsMap = new Map<string, CalendarEvent>();
    
    // Process default events first so they are present in fallback state
    if (Array.isArray(DEFAULT_EVENTS)) {
      DEFAULT_EVENTS.forEach(e => {
        if (e && e.id) allEventsMap.set(e.id, e);
      });
    }

    // Process keys and merge calendar events
    for (const key of keysToCheck) {
      const stored = localStorage.getItem(key);
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          if (Array.isArray(parsed)) {
            parsed.forEach((e: CalendarEvent) => {
              if (e && e.id) {
                const existing = allEventsMap.get(e.id);
                allEventsMap.set(e.id, { ...existing, ...e });
              }
            });
          }
        } catch (err) {
          console.error(`Failed to parse events from key ${key}:`, err);
        }
      }
    }
    
    const mergedList = Array.from(allEventsMap.values());
    localStorage.setItem('calendarEvents', JSON.stringify(mergedList));
    return mergedList;
  });

  // Track active layer filters
  const [activeLayers, setActiveLayers] = useState<Record<CalendarLayer, boolean>>(() => {
    const saved = localStorage.getItem('layer_calendar_active_layers');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        console.error('Failed to parse saved active layers:', e);
      }
    }
    return {
      'No School': true,
      'ED 895': true,
      'EDL 830': true,
      'Other': true,
    };
  });

  // Default initial date to today (current date) using new Date()
  const [currentDate, setCurrentDate] = useState<Date>(() => new Date());
  const [currentView, setCurrentView] = useState<CalendarView>('Month');
  const [todayClickCount, setTodayClickCount] = useState(0);

  // Dynamic categories/layers configurations
  const [layers, setLayers] = useState<LayerConfig[]>(() => {
    const saved = localStorage.getItem('layer_calendar_custom_layers');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        console.error('Failed to parse saved custom layers:', e);
      }
    }
    return [
      { id: 'No School', name: 'No School', color: '#64748b' },
      { id: 'ED 895', name: 'ED 895', color: '#1F4E79' },
      { id: 'EDL 830', name: 'EDL 830', color: '#047857' },
      { id: 'Other', name: 'Other', color: '#B45309' },
    ];
  });

  const [appAccentColor, setAppAccentColor] = useState<string>(() => {
    return localStorage.getItem('layer_calendar_app_accent') || '#0F172A';
  });

  const [mobileHeaderOption, setMobileHeaderOption] = useState<'full' | 'compact' | 'hidden'>(() => {
    const saved = localStorage.getItem('layer_calendar_mobile_header');
    if (saved === 'full' || saved === 'compact' || saved === 'hidden') {
      return saved;
    }
    return 'compact';
  });

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isHeaderCollapsed, setIsHeaderCollapsed] = useState<boolean>(false);
  const [lastScrollTop, setLastScrollTop] = useState<number>(0);

  const handleScroll = (e: UIEvent<HTMLDivElement>) => {
    if (window.innerWidth >= 768) return;
    if (currentView === 'Month') {
      if (isHeaderCollapsed) {
        setIsHeaderCollapsed(false);
      }
      return;
    }
    const scrollTop = e.currentTarget.scrollTop;
    // Hide header if scrolling down past a threshold of 15px
    if (scrollTop > lastScrollTop && scrollTop > 15) {
      if (!isHeaderCollapsed) {
        setIsHeaderCollapsed(true);
      }
    } else if (scrollTop < lastScrollTop || scrollTop <= 5) {
      if (isHeaderCollapsed) {
        setIsHeaderCollapsed(false);
      }
    }
    setLastScrollTop(scrollTop);
  };

  // Modals status
  const [isEventModalOpen, setIsEventModalOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);
  const [addingEventOnDate, setAddingEventOnDate] = useState<string | undefined>(undefined);

  const [isEventDetailsOpen, setIsEventDetailsOpen] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);

  const [isBuildTodoOpen, setIsBuildTodoOpen] = useState(false);
  const [isViewTodoOpen, setIsViewTodoOpen] = useState(false);
  const [selectedTodoId, setSelectedTodoId] = useState<string | null>(null);
  const [workSessionTaskToComplete, setWorkSessionTaskToComplete] = useState<TodoItem | null>(null);
  const [todos, setTodos] = useState<TodoItem[]>(() => {
    const { tasks } = loadTasksV1();
    return tasks;
  });
  const [showRecoveryBanner, setShowRecoveryBanner] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(() => {
    const saved = localStorage.getItem('layer_calendar_sidebar_open');
    return saved !== null ? saved === 'true' : true;
  });
  const [hideDueItems, setHideDueItems] = useState<boolean>(() => {
    const saved = localStorage.getItem('layer_calendar_hide_due_items');
    return saved !== null ? saved === 'true' : false;
  });

  // Firebase auth & synchronization states
  const [user, setUser] = useState<User | null>(null);
  const [isAuthChecking, setIsAuthChecking] = useState(true);
  const [showMigrationPrompt, setShowMigrationPrompt] = useState(false);
  const [isCloudLoading, setIsCloudLoading] = useState(false);
  const [isMigrating, setIsMigrating] = useState(false);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [cloudSaveStatus, setCloudSaveStatus] = useState<string>("Not signed in");

  // New Synchronization and conflict handling states
  const [showSyncConflictModal, setShowSyncConflictModal] = useState(false);
  const [pendingCloudData, setPendingCloudData] = useState<PlannerData | null>(null);
  const [lastSavedStateDump, setLastSavedStateDump] = useState<string>('');

  const isSyncActiveRef = useRef<boolean>(false);
  const ignoreNextUpdateRef = useRef<boolean>(false);
  const lastSyncedTimestampRef = useRef<number>(0);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const lastSavedStateDumpRef = useRef<string>('');
  const preventSyncUntilRef = useRef<number>(0);

  // Unified normalization helper to ensure identical JSON keys and format for comparison
  const normalizePlannerData = (data: any): string => {
    return JSON.stringify(cleanUndefined({
      tasks: data.tasks || [],
      events: data.events || [],
      layers: data.layers || [],
      activeLayers: data.activeLayers || {},
      appAccentColor: data.appAccentColor || '#0F172A',
      mobileHeaderOption: data.mobileHeaderOption || 'compact',
      sidebarOpen: data.sidebarOpen !== undefined ? data.sidebarOpen : true,
      hideDueItems: data.hideDueItems !== undefined ? data.hideDueItems : false,
    }));
  };

  const handleGoogleLogin = async () => {
    if (!isFirebaseConfigured()) {
      const errMsg = "Firebase is not configured. Please provision Firebase and deploy rules in AI Studio Settings.";
      alert(`Cloud Save Error:\n\n${errMsg}`);
      setCloudSaveStatus(`Cloud save failed: ${errMsg}`);
      return;
    }
    
    setCloudSaveStatus("Saving...");
    try {
      const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth < 768;
      if (isMobile) {
        await signInWithRedirect(auth, googleProvider);
      } else {
        await signInWithPopup(auth, googleProvider);
      }
    } catch (err) {
      console.error("Sign in failed:", err);
      const reason = err instanceof Error ? err.message : String(err);
      setCloudSaveStatus(`Cloud save failed: ${reason}`);
      alert(`Cloud Save Login Failed:\n\n${reason}`);
    }
  };

  // Local write/backup function
  const saveAllToLocalBackup = (
    currentTasks: TodoItem[],
    currentEvents: CalendarEvent[],
    currentLayers: LayerConfig[],
    currentActiveLayers: Record<string, boolean>,
    currentAccentColor: string,
    currentMobileHeaderOption: 'full' | 'compact' | 'hidden',
    currentSidebarOpen: boolean,
    currentHideDueItems?: boolean
  ) => {
    try {
      localStorage.setItem('layerCalendar_tasks_v1', JSON.stringify(currentTasks));
      localStorage.setItem('calendarEvents', JSON.stringify(currentEvents));
      localStorage.setItem('layer_calendar_custom_layers', JSON.stringify(currentLayers));
      localStorage.setItem('layer_calendar_active_layers', JSON.stringify(currentActiveLayers));
      localStorage.setItem('layer_calendar_app_accent', currentAccentColor);
      localStorage.setItem('layer_calendar_mobile_header', currentMobileHeaderOption);
      localStorage.setItem('layer_calendar_sidebar_open', String(currentSidebarOpen));
      localStorage.setItem('layer_calendar_hide_due_items', String(currentHideDueItems !== undefined ? currentHideDueItems : false));
    } catch (e) {
      console.error("[Sync] Local storage backup failed:", e);
    }
  };

  // Start subscription helper for real-time sync with snapshot
  const startRealTimeSync = (userId: string) => {
    if (unsubscribeRef.current) {
      unsubscribeRef.current();
    }
    
    unsubscribeRef.current = subscribePlannerData(
      userId,
      (cloudDoc) => {
        if (!cloudDoc) return;
        
        // Use an updatedAt check to protect temporal sequence
        if (cloudDoc.updatedAt > lastSyncedTimestampRef.current) {
          console.log("[Sync] Received newer planner data from cloud. Synchronizing state across devices.", cloudDoc.updatedAt);
          
          // Disable synchronization write-back loop temporarily during state transition
          preventSyncUntilRef.current = Date.now() + 1000;
          
          if (cloudDoc.events) setEvents(cloudDoc.events);
          if (cloudDoc.tasks) setTodos(cloudDoc.tasks);
          if (cloudDoc.layers) setLayers(cloudDoc.layers);
          if (cloudDoc.activeLayers) setActiveLayers(cloudDoc.activeLayers);
          if (cloudDoc.appAccentColor) setAppAccentColor(cloudDoc.appAccentColor);
          if (cloudDoc.mobileHeaderOption) {
            setMobileHeaderOption(cloudDoc.mobileHeaderOption as any);
          }
          if (cloudDoc.sidebarOpen !== undefined) {
            setIsSidebarOpen(cloudDoc.sidebarOpen);
          }
          if (cloudDoc.hideDueItems !== undefined) {
            setHideDueItems(cloudDoc.hideDueItems);
          }
          
          // Backup locally
          saveAllToLocalBackup(
            cloudDoc.tasks || [],
            cloudDoc.events || [],
            cloudDoc.layers || [],
            cloudDoc.activeLayers || {},
            cloudDoc.appAccentColor || '',
            cloudDoc.mobileHeaderOption as any || 'compact',
            cloudDoc.sidebarOpen ?? true,
            cloudDoc.hideDueItems ?? false
          );
          
          lastSyncedTimestampRef.current = cloudDoc.updatedAt;
          
          const normalizedStr = normalizePlannerData(cloudDoc);
          lastSavedStateDumpRef.current = normalizedStr;
          setLastSavedStateDump(normalizedStr);
          
          setCloudSaveStatus("Saved to cloud");
        }
      },
      (error) => {
        console.error("[Sync] Subscription failure:", error);
        const reason = error instanceof Error ? error.message : String(error);
        if (reason.toLowerCase().includes("quota") || reason.toLowerCase().includes("resource-exhausted")) {
          triggerQuotaOffline();
          setCloudSaveStatus("Cloud Sync Quota Exceeded (Operating Offline)");
          isSyncActiveRef.current = false;
          if (unsubscribeRef.current) {
            try {
              unsubscribeRef.current();
            } catch (e) {
              console.error("Unsubscribe error:", e);
            }
            unsubscribeRef.current = null;
          }
        } else {
          setCloudSaveStatus(`Cloud save failed: ${reason}`);
        }
      }
    );
  };

  // Unified Auth & Initial Boot Sync Loader
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      setIsAuthChecking(false);
      
      if (currentUser) {
        setCloudSaveStatus(`Signed in as: ${currentUser.email || currentUser.uid}`);
        setIsCloudLoading(true);
        try {
          // Fetch unified document from Firestore
          const cloudDoc = await getPlannerData(currentUser.uid);
          
          if (!cloudDoc) {
            // No cloud data exists (first sync)
            const hasActualLocalEvent = events.length > 0 && !events.every(e => e.id.startsWith('default-'));
            const hasActualLocalTodo = todos.length > 0;
            
            if (hasActualLocalEvent || hasActualLocalTodo) {
              setShowMigrationPrompt(true);
            } else {
              // Completely empty / new profile. Let's create initial template in cloud
              const currentNow = Date.now();
              const initialPayload = {
                tasks: todos,
                events,
                layers,
                activeLayers,
                appAccentColor,
                mobileHeaderOption,
                sidebarOpen: isSidebarOpen,
                hideDueItems,
                updatedAt: currentNow,
              };
              await savePlannerData(currentUser.uid, initialPayload);
              lastSyncedTimestampRef.current = currentNow;
              
              const normalizedStr = normalizePlannerData(initialPayload);
              lastSavedStateDumpRef.current = normalizedStr;
              setLastSavedStateDump(normalizedStr);
              
              isSyncActiveRef.current = true;
              startRealTimeSync(currentUser.uid);
              setCloudSaveStatus("Saved to cloud");
            }
          } else {
            // Cloud document exists. Check difference.
            const localDump = normalizePlannerData({
              tasks: todos,
              events,
              layers,
              activeLayers,
              appAccentColor,
              mobileHeaderOption,
              sidebarOpen: isSidebarOpen,
              hideDueItems,
            });
            const cloudDump = normalizePlannerData(cloudDoc);
            
            const isDifferent = localDump !== cloudDump;
            
            if (!isDifferent) {
              setEvents(cloudDoc.events || []);
              setTodos(cloudDoc.tasks || []);
              if (cloudDoc.layers) setLayers(cloudDoc.layers);
              if (cloudDoc.activeLayers) setActiveLayers(cloudDoc.activeLayers);
              if (cloudDoc.appAccentColor) setAppAccentColor(cloudDoc.appAccentColor);
              if (cloudDoc.mobileHeaderOption) setMobileHeaderOption(cloudDoc.mobileHeaderOption as any);
              if (cloudDoc.sidebarOpen !== undefined) setIsSidebarOpen(cloudDoc.sidebarOpen);
              if (cloudDoc.hideDueItems !== undefined) setHideDueItems(cloudDoc.hideDueItems);
              
              saveAllToLocalBackup(
                cloudDoc.tasks || [],
                cloudDoc.events || [],
                cloudDoc.layers || layers,
                cloudDoc.activeLayers || activeLayers,
                cloudDoc.appAccentColor || appAccentColor,
                cloudDoc.mobileHeaderOption as any || mobileHeaderOption,
                cloudDoc.sidebarOpen ?? isSidebarOpen,
                cloudDoc.hideDueItems ?? hideDueItems
              );
              
              lastSyncedTimestampRef.current = cloudDoc.updatedAt || Date.now();
              lastSavedStateDumpRef.current = cloudDump;
              setLastSavedStateDump(cloudDump);
              
              isSyncActiveRef.current = true;
              startRealTimeSync(currentUser.uid);
              setCloudSaveStatus("Saved to cloud");
            } else {
              const savedSyncPref = localStorage.getItem('layer_calendar_sync_behavior') || 'merge';
              if (savedSyncPref === 'merge') {
                setCloudSaveStatus("Syncing...");
                setTimeout(async () => {
                  try {
                    setCloudSaveStatus("Merging cloud and local data...");
                    await runMergeLogic(
                      currentUser.uid,
                      cloudDoc,
                      todos,
                      events,
                      layers,
                      activeLayers,
                      appAccentColor,
                      mobileHeaderOption,
                      isSidebarOpen
                    );
                    setCloudSaveStatus("Sync complete");
                    setTimeout(() => {
                      setCloudSaveStatus("Saved to cloud");
                    }, 4000);
                  } catch (e) {
                    console.error("Auto-merge failed during auth init:", e);
                    setCloudSaveStatus("Cloud save failed: Auto-merge error");
                    setPendingCloudData(cloudDoc);
                    setShowSyncConflictModal(true);
                  }
                }, 800);
              } else if (savedSyncPref === 'cloud') {
                setCloudSaveStatus("Syncing...");
                setTimeout(async () => {
                  try {
                    setCloudSaveStatus("Updating device... Using cloud data");
                    await runUseCloudLogic(
                      currentUser.uid,
                      cloudDoc,
                      todos,
                      events,
                      layers,
                      activeLayers,
                      appAccentColor,
                      mobileHeaderOption,
                      isSidebarOpen
                    );
                    setCloudSaveStatus("Sync complete");
                    setTimeout(() => {
                      setCloudSaveStatus("Saved to cloud");
                    }, 4000);
                  } catch (e) {
                    console.error("Auto-use-cloud failed during auth init:", e);
                    setCloudSaveStatus("Cloud save failed: Auto-sync error");
                    setPendingCloudData(cloudDoc);
                    setShowSyncConflictModal(true);
                  }
                }, 800);
              } else if (savedSyncPref === 'local') {
                setCloudSaveStatus("Syncing...");
                setTimeout(async () => {
                  try {
                    setCloudSaveStatus("Uploading local planner data...");
                    await runUploadLocalLogic(
                      currentUser.uid,
                      todos,
                      events,
                      layers,
                      activeLayers,
                      appAccentColor,
                      mobileHeaderOption,
                      isSidebarOpen
                    );
                    setCloudSaveStatus("Sync complete");
                    setTimeout(() => {
                      setCloudSaveStatus("Saved to cloud");
                    }, 4000);
                  } catch (e) {
                    console.error("Auto-upload-local failed during auth init:", e);
                    setCloudSaveStatus("Cloud save failed: Auto-sync error");
                    setPendingCloudData(cloudDoc);
                    setShowSyncConflictModal(true);
                  }
                }, 800);
              } else {
                // 'ask'
                setPendingCloudData(cloudDoc);
                setShowSyncConflictModal(true);
              }
            }
          }
        } catch (err) {
          console.error("Initialization check failed:", err);
          const reason = err instanceof Error ? err.message : String(err);
          if (reason.toLowerCase().includes("quota") || reason.toLowerCase().includes("resource-exhausted")) {
            triggerQuotaOffline();
            setCloudSaveStatus("Cloud Sync Quota Exceeded (Operating Offline)");
          } else {
            setCloudSaveStatus(`Cloud save failed: ${reason}`);
          }
          isSyncActiveRef.current = false;
        } finally {
          setIsCloudLoading(false);
        }
      } else {
        setCloudSaveStatus("Not signed in");
        isSyncActiveRef.current = false;
        if (unsubscribeRef.current) {
          unsubscribeRef.current();
          unsubscribeRef.current = null;
        }
      }
    });
    
    return () => {
      unsubscribe();
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
    };
  }, []);

  const handleMigrateData = async () => {
    if (!user) return;
    setIsMigrating(true);
    try {
      const currentNow = Date.now();
      const payload = {
        tasks: todos,
        events,
        layers,
        activeLayers,
        appAccentColor,
        mobileHeaderOption,
        sidebarOpen: isSidebarOpen,
        hideDueItems,
        updatedAt: currentNow,
      };
      await savePlannerData(user.uid, payload);
      lastSyncedTimestampRef.current = currentNow;
      
      const normalizedStr = normalizePlannerData(payload);
      lastSavedStateDumpRef.current = normalizedStr;
      setLastSavedStateDump(normalizedStr);
      
      isSyncActiveRef.current = true;
      startRealTimeSync(user.uid);
      setCloudSaveStatus("Saved to cloud");
    } catch (err) {
      console.error("Migration failed:", err);
      const reason = err instanceof Error ? err.message : String(err);
      setCloudSaveStatus(`Cloud save failed: ${reason}`);
    } finally {
      setIsMigrating(false);
      setShowMigrationPrompt(false);
    }
  };

  const handleSkipMigration = async () => {
    if (!user) return;
    try {
      const currentNow = Date.now();
      const payload = {
        tasks: [],
        events: [],
        layers: [
          { id: 'No School', name: 'No School', color: '#64748b' },
          { id: 'ED 895', name: 'ED 895', color: '#1F4E79' },
          { id: 'EDL 830', name: 'EDL 830', color: '#047857' },
          { id: 'Other', name: 'Other', color: '#B45309' },
        ],
        activeLayers: {
          'No School': true,
          'ED 895': true,
          'EDL 830': true,
          'Other': true,
        },
        appAccentColor: '#0F172A',
        mobileHeaderOption: 'compact',
        sidebarOpen: true,
        hideDueItems: false,
        updatedAt: currentNow,
      };
      await savePlannerData(user.uid, payload);
      setEvents([]);
      setTodos([]);
      setLayers([
        { id: 'No School', name: 'No School', color: '#64748b' },
        { id: 'ED 895', name: 'ED 895', color: '#1F4E79' },
        { id: 'EDL 830', name: 'EDL 830', color: '#047857' },
        { id: 'Other', name: 'Other', color: '#B45309' },
      ]);
      setActiveLayers({
        'No School': true,
        'ED 895': true,
        'EDL 830': true,
        'Other': true,
      });
      setAppAccentColor('#0F172A');
      setMobileHeaderOption('compact');
      setIsSidebarOpen(true);
      setHideDueItems(false);
      
      saveAllToLocalBackup([], [], [
        { id: 'No School', name: 'No School', color: '#64748b' },
        { id: 'ED 895', name: 'ED 895', color: '#1F4E79' },
        { id: 'EDL 830', name: 'EDL 830', color: '#047857' },
        { id: 'Other', name: 'Other', color: '#B45309' },
      ], {
        'No School': true,
        'ED 895': true,
        'EDL 830': true,
        'Other': true,
      }, '#0F172A', 'compact', true, false);

      lastSyncedTimestampRef.current = currentNow;
      
      const normalizedStr = normalizePlannerData(payload);
      lastSavedStateDumpRef.current = normalizedStr;
      setLastSavedStateDump(normalizedStr);

      isSyncActiveRef.current = true;
      startRealTimeSync(user.uid);
      setCloudSaveStatus("Saved to cloud");
    } catch (err) {
      console.error("Skipping migration setup failed:", err);
    } finally {
      setShowMigrationPrompt(false);
    }
  };

  // Reusable background sync / merge helpers
  const runMergeLogic = async (
    userId: string,
    cloudDoc: PlannerData,
    localTasks: TodoItem[],
    localEvents: CalendarEvent[],
    localLayers: LayerConfig[],
    localActiveLayers: Record<string, boolean>,
    localAccentColor: string,
    localMobileHeader: 'full' | 'compact' | 'hidden',
    localSidebarOpen: boolean
  ) => {
    // 1. Create backup first under a conflict backup timestamp
    try {
      localStorage.setItem('layer_calendar_conflict_backup_' + Date.now(), JSON.stringify({
        tasks: localTasks,
        events: localEvents,
        layers: localLayers,
        activeLayers: localActiveLayers,
        appAccentColor: localAccentColor,
        mobileHeaderOption: localMobileHeader,
        sidebarOpen: localSidebarOpen,
      }));
    } catch (e) {
      console.error("Backup before merge failed:", e);
    }

    // 2. Merge Tasks
    const mergedTasksMap = new Map<string, TodoItem>();
    
    // Process cloud tasks first
    (cloudDoc.tasks || []).forEach(task => {
      if (task && task.id) {
        mergedTasksMap.set(task.id, { ...task });
      }
    });

    // Process local tasks and merge with cloud task if ID overlaps
    localTasks.forEach(localTask => {
      if (localTask && localTask.id) {
        const existing = mergedTasksMap.get(localTask.id);
        if (existing) {
          const merged = { ...existing, ...localTask };
          
          // Preserve completed status: if either is completed, mark as completed
          if (localTask.completed || existing.completed) {
            merged.completed = true;
            merged.completedDate = localTask.completedDate || existing.completedDate || new Date().toISOString();
          } else {
            merged.completed = false;
          }

          // Preserve saved-for-later status
          if (localTask.savedForLater || existing.savedForLater) {
            merged.savedForLater = true;
          }
          if (localTask.section === 'maybeSomeday' || existing.section === 'maybeSomeday') {
            merged.section = 'maybeSomeday';
          }

          // Preserve scheduled work sessions
          const sessionsMap = new Map<string, ScheduledWorkSession>();
          (existing.scheduledSessions || []).forEach(s => {
            if (s && s.id) sessionsMap.set(s.id, s);
          });
          (localTask.scheduledSessions || []).forEach(s => {
            if (s && s.id) sessionsMap.set(s.id, s);
          });
          merged.scheduledSessions = Array.from(sessionsMap.values());

          mergedTasksMap.set(localTask.id, merged);
        } else {
          mergedTasksMap.set(localTask.id, { ...localTask });
        }
      }
    });

    // 3. Merge Calendar Events
    const mergedEventsMap = new Map<string, CalendarEvent>();
    
    // Process cloud events
    (cloudDoc.events || []).forEach(e => {
      if (e && e.id) {
        mergedEventsMap.set(e.id, { ...e });
      }
    });

    // Process local events
    localEvents.forEach(localEvent => {
      if (localEvent && localEvent.id) {
        const existing = mergedEventsMap.get(localEvent.id);
        if (existing) {
          const merged = { ...existing, ...localEvent };
          
          // Preserve completion
          if (localEvent.completed || existing.completed) {
            merged.completed = true;
          }
          
          // Preserve isWorkSession, isFixed, todoId, etc.
          merged.isWorkSession = localEvent.isWorkSession || existing.isWorkSession;
          merged.isFixed = localEvent.isFixed || existing.isFixed;
          merged.todoId = localEvent.todoId || existing.todoId;

          mergedEventsMap.set(localEvent.id, merged);
        } else {
          mergedEventsMap.set(localEvent.id, { ...localEvent });
        }
      }
    });

    // 4. Merge Custom Layers
    const mergedLayersMap = new Map<string, LayerConfig>();
    
    // Standard layers
    const standardLayers = [
      { id: 'No School', name: 'No School', color: '#64748b' },
      { id: 'ED 895', name: 'ED 895', color: '#1F4E79' },
      { id: 'EDL 830', name: 'EDL 830', color: '#047857' },
      { id: 'Other', name: 'Other', color: '#B45309' },
    ];
    standardLayers.forEach(l => mergedLayersMap.set(l.id, l));
    
    // Cloud layers
    (cloudDoc.layers || []).forEach(l => {
      if (l && l.id) {
        mergedLayersMap.set(l.id, { ...l });
      }
    });

    // Local layers
    localLayers.forEach(l => {
      if (l && l.id) {
        mergedLayersMap.set(l.id, { ...l });
      }
    });

    const mergedActiveLayers = { ...(cloudDoc.activeLayers || {}), ...localActiveLayers };
    const mergedTasks = Array.from(mergedTasksMap.values());
    const mergedEvents = Array.from(mergedEventsMap.values());
    const mergedLayers = Array.from(mergedLayersMap.values());
    const mergedAccent = cloudDoc.appAccentColor || localAccentColor;
    const mergedMobileHeader = cloudDoc.mobileHeaderOption || localMobileHeader;
    const mergedSidebarOpen = cloudDoc.sidebarOpen !== undefined ? cloudDoc.sidebarOpen : localSidebarOpen;

    if (mergedLayers.length === 0) {
      throw new Error("Layers data is corrupted or empty after merger validation");
    }

    // 5. Update React states
    setTodos(mergedTasks);
    setEvents(mergedEvents);
    setLayers(mergedLayers);
    setActiveLayers(mergedActiveLayers);
    setAppAccentColor(mergedAccent);
    setMobileHeaderOption(mergedMobileHeader as any);
    setIsSidebarOpen(mergedSidebarOpen);

    // 6. Save merged to local backups
    saveAllToLocalBackup(
      mergedTasks,
      mergedEvents,
      mergedLayers,
      mergedActiveLayers,
      mergedAccent,
      mergedMobileHeader as any,
      mergedSidebarOpen
    );

    // 7. Save merged to Cloud
    const currentNow = Date.now();
    const payload = {
      tasks: mergedTasks,
      events: mergedEvents,
      layers: mergedLayers,
      activeLayers: mergedActiveLayers,
      appAccentColor: mergedAccent,
      mobileHeaderOption: mergedMobileHeader,
      sidebarOpen: mergedSidebarOpen,
      updatedAt: currentNow,
    };

    await savePlannerData(userId, payload);
    lastSyncedTimestampRef.current = currentNow;
    
    const normalizedStr = normalizePlannerData(payload);
    lastSavedStateDumpRef.current = normalizedStr;
    setLastSavedStateDump(normalizedStr);

    isSyncActiveRef.current = true;
    startRealTimeSync(userId);
  };

  const runUseCloudLogic = async (
    userId: string,
    cloudDoc: PlannerData,
    localTasks: TodoItem[],
    localEvents: CalendarEvent[],
    localLayers: LayerConfig[],
    localActiveLayers: Record<string, boolean>,
    localAccentColor: string,
    localMobileHeader: 'full' | 'compact' | 'hidden',
    localSidebarOpen: boolean
  ) => {
    // Backup current local first
    try {
      localStorage.setItem('layer_calendar_conflict_backup_' + Date.now(), JSON.stringify({
        tasks: localTasks,
        events: localEvents,
        layers: localLayers,
        activeLayers: localActiveLayers,
        appAccentColor: localAccentColor,
        mobileHeaderOption: localMobileHeader,
        sidebarOpen: localSidebarOpen,
      }));
    } catch (e) {
      console.error("Backup before cloud selection failed:", e);
    }

    setEvents(cloudDoc.events || []);
    setTodos(cloudDoc.tasks || []);
    if (cloudDoc.layers) setLayers(cloudDoc.layers);
    if (cloudDoc.activeLayers) setActiveLayers(cloudDoc.activeLayers);
    if (cloudDoc.appAccentColor) setAppAccentColor(cloudDoc.appAccentColor);
    if (cloudDoc.mobileHeaderOption) setMobileHeaderOption(cloudDoc.mobileHeaderOption as any);
    if (cloudDoc.sidebarOpen !== undefined) setIsSidebarOpen(cloudDoc.sidebarOpen);

    saveAllToLocalBackup(
      cloudDoc.tasks || [],
      cloudDoc.events || [],
      cloudDoc.layers || localLayers,
      cloudDoc.activeLayers || localActiveLayers,
      cloudDoc.appAccentColor || localAccentColor,
      cloudDoc.mobileHeaderOption as any || localMobileHeader,
      cloudDoc.sidebarOpen ?? localSidebarOpen
    );

    lastSyncedTimestampRef.current = cloudDoc.updatedAt || Date.now();
    
    const normalizedStr = normalizePlannerData(cloudDoc);
    lastSavedStateDumpRef.current = normalizedStr;
    setLastSavedStateDump(normalizedStr);

    isSyncActiveRef.current = true;
    startRealTimeSync(userId);
  };

  const runUploadLocalLogic = async (
    userId: string,
    localTasks: TodoItem[],
    localEvents: CalendarEvent[],
    localLayers: LayerConfig[],
    localActiveLayers: Record<string, boolean>,
    localAccentColor: string,
    localMobileHeader: 'full' | 'compact' | 'hidden',
    localSidebarOpen: boolean
  ) => {
    const currentNow = Date.now();
    const payload = {
      tasks: localTasks,
      events: localEvents,
      layers: localLayers,
      activeLayers: localActiveLayers,
      appAccentColor: localAccentColor,
      mobileHeaderOption: localMobileHeader,
      sidebarOpen: localSidebarOpen,
      updatedAt: currentNow,
    };
    await savePlannerData(userId, payload);
    lastSyncedTimestampRef.current = currentNow;
    
    const normalizedStr = normalizePlannerData(payload);
    lastSavedStateDumpRef.current = normalizedStr;
    setLastSavedStateDump(normalizedStr);
    
    isSyncActiveRef.current = true;
    startRealTimeSync(userId);
  };

  // Conflict handlers
  const handleConflictUseCloud = async () => {
    if (!pendingCloudData || !user) return;
    setCloudSaveStatus("Saving...");
    try {
      await runUseCloudLogic(user.uid, pendingCloudData, todos, events, layers, activeLayers, appAccentColor, mobileHeaderOption, isSidebarOpen);
      setCloudSaveStatus("Saved to cloud");
    } catch (e) {
      console.error("Conflict cloud restore failed:", e);
      setCloudSaveStatus("Cloud save failed");
    } finally {
      setShowSyncConflictModal(false);
      setPendingCloudData(null);
    }
  };

  const handleConflictUploadLocal = async () => {
    if (!user) return;
    setCloudSaveStatus("Saving...");
    try {
      await runUploadLocalLogic(user.uid, todos, events, layers, activeLayers, appAccentColor, mobileHeaderOption, isSidebarOpen);
      setCloudSaveStatus("Saved to cloud");
    } catch (err) {
      console.error("Uploading local on conflict failed:", err);
      const reason = err instanceof Error ? err.message : String(err);
      setCloudSaveStatus(`Cloud save failed: ${reason}`);
    } finally {
      setShowSyncConflictModal(false);
      setPendingCloudData(null);
    }
  };

  const handleConflictMergeBoth = async () => {
    if (!user || !pendingCloudData) return;
    setCloudSaveStatus("Saving...");
    try {
      await runMergeLogic(user.uid, pendingCloudData, todos, events, layers, activeLayers, appAccentColor, mobileHeaderOption, isSidebarOpen);
      setCloudSaveStatus("Saved to cloud");
    } catch (err) {
      console.error("Merging copies failed:", err);
      const reason = err instanceof Error ? err.message : String(err);
      setCloudSaveStatus(`Cloud save failed: ${reason}`);
    } finally {
      setShowSyncConflictModal(false);
      setPendingCloudData(null);
    }
  };

  // Sync state changes local-backups
  useEffect(() => {
    localStorage.setItem('calendarEvents', JSON.stringify(events));
  }, [events]);

  useEffect(() => {
    localStorage.setItem('layer_calendar_active_layers', JSON.stringify(activeLayers));
  }, [activeLayers]);

  useEffect(() => {
    localStorage.setItem('layer_calendar_custom_layers', JSON.stringify(layers));
  }, [layers]);

  useEffect(() => {
    localStorage.setItem('layer_calendar_app_accent', appAccentColor);
    const root = document.documentElement;
    root.style.setProperty('--app-accent', appAccentColor);
    root.style.setProperty('--app-accent-light', appAccentColor + '15');
    root.style.setProperty('--app-accent-dark', appAccentColor);
  }, [appAccentColor]);

  useEffect(() => {
    localStorage.setItem('layer_calendar_mobile_header', mobileHeaderOption);
  }, [mobileHeaderOption]);

  useEffect(() => {
    localStorage.setItem('layer_calendar_sidebar_open', String(isSidebarOpen));
  }, [isSidebarOpen]);

  useEffect(() => {
    localStorage.setItem('layer_calendar_hide_due_items', String(hideDueItems));
  }, [hideDueItems]);

  const currentStateDump = useMemo(() => {
    return normalizePlannerData({
      tasks: todos,
      events,
      layers,
      activeLayers,
      appAccentColor,
      mobileHeaderOption,
      sidebarOpen: isSidebarOpen,
      hideDueItems,
    });
  }, [todos, events, layers, activeLayers, appAccentColor, mobileHeaderOption, isSidebarOpen, hideDueItems]);

  // Combined Cloud Syncer Effect with Debounce to protect Quota Limits
  useEffect(() => {
    if (!user || !isSyncActiveRef.current) return;
    
    // Check if cloud saves are temporarily blocked due to a recent incoming real-time snapshot
    if (Date.now() < preventSyncUntilRef.current) {
      return;
    }

    if (currentStateDump === lastSavedStateDump || currentStateDump === lastSavedStateDumpRef.current) {
      return;
    }

    // Indicate that sync is pending to avoid immediate write loops
    setCloudSaveStatus("Pending...");

    const saveTimeout = setTimeout(() => {
      setCloudSaveStatus("Saving...");
      const now = Date.now();
      lastSyncedTimestampRef.current = now;
      
      saveAllToLocalBackup(
        todos,
        events,
        layers,
        activeLayers,
        appAccentColor,
        mobileHeaderOption,
        isSidebarOpen,
        hideDueItems
      );

      const payload = {
        tasks: todos,
        events,
        layers,
        activeLayers,
        appAccentColor,
        mobileHeaderOption,
        sidebarOpen: isSidebarOpen,
        hideDueItems,
        updatedAt: now,
      };

      lastSavedStateDumpRef.current = currentStateDump;
      setLastSavedStateDump(currentStateDump);

      savePlannerData(user.uid, payload)
        .then(() => {
          setCloudSaveStatus("Saved to cloud");
        })
        .catch((err) => {
          console.error("Cloud save failed:", err);
          const reason = err instanceof Error ? err.message : String(err);
          if (reason.toLowerCase().includes("quota") || reason.toLowerCase().includes("resource-exhausted")) {
            triggerQuotaOffline();
            setCloudSaveStatus("Cloud Sync Quota Exceeded (Operating Offline)");
            isSyncActiveRef.current = false;
          } else {
            setCloudSaveStatus(`Cloud save failed: ${reason}`);
          }
        });
    }, 2000); // 2-second debounce for state stabilisation

    return () => clearTimeout(saveTimeout);
  }, [currentStateDump, user, lastSavedStateDump]);

  const handleExportBackup = () => {
    const backupData = {
      events,
      todos,
      layers,
      activeLayers,
      appAccentColor,
      exportedAt: new Date().toISOString(),
      version: '1'
    };
    
    const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `planner-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleSignOut = async () => {
    await signOut(auth);
    setUser(null);
    isSyncActiveRef.current = false;
    if (unsubscribeRef.current) {
      unsubscribeRef.current();
      unsubscribeRef.current = null;
    }
    const savedNew = localStorage.getItem('calendarEvents');
    setEvents(savedNew ? JSON.parse(savedNew) : DEFAULT_EVENTS);
    const { tasks } = loadTasksV1();
    setTodos(tasks);
  };

  const handleSaveLayers = (newLayers: LayerConfig[]) => {
    let updatedEvents = [...events];
    let updatedTodos = [...todos];
    let updatedActiveLayers = { ...activeLayers };

    layers.forEach((oldLayer) => {
      const matchingNew = newLayers.find(nl => nl.id === oldLayer.id);
      if (matchingNew && matchingNew.name !== oldLayer.name) {
        // Dynamic rename cascade to all elements
        updatedEvents = updatedEvents.map(e => e.layer === oldLayer.name ? { ...e, layer: matchingNew.name } : e);
        updatedTodos = updatedTodos.map(todo => todo.layer === oldLayer.name ? { ...todo, layer: matchingNew.name } : todo);

        if (oldLayer.name in updatedActiveLayers) {
          updatedActiveLayers[matchingNew.name] = updatedActiveLayers[oldLayer.name];
          delete updatedActiveLayers[oldLayer.name];
        }
      }
    });

    newLayers.forEach((nl) => {
      if (!(nl.name in updatedActiveLayers)) {
        updatedActiveLayers[nl.name] = true;
      }
    });

    setLayers(newLayers);
    setEvents(updatedEvents);
    setTodos(updatedTodos);
  };

  // Load todos for due dates integration
  const loadTodos = () => {
    const { tasks, hasUnrestoredLegacy } = loadTasksV1();
    setTodos(tasks);
    if (hasUnrestoredLegacy) {
      setShowRecoveryBanner(true);
    }
  };

  useEffect(() => {
    loadTodos();

    // Recalculate and auto-prioritize tasks when the user is idle or the date rolls over
    const intervalId = setInterval(() => {
      loadTodos();
    }, 60000);
    return () => clearInterval(intervalId);
  }, []);

  const openTodoList = () => {
    setIsViewTodoOpen(true);
  };

  const handleRestoreLegacyTodos = () => {
    const { legacyTasks } = loadTasksV1();
    if (legacyTasks.length > 0) {
      setTodos(legacyTasks);
      saveTasksV1(legacyTasks);
    }
    setShowRecoveryBanner(false);
  };

  const combinedEvents = useMemo(() => {
    return events.map((event) => {
      // Find if there is any todo that has a scheduled session with this event id
      const linkedTodo = todos.find((todo) =>
        (todo.scheduledSessions || []).some((session) => session.id === event.id)
      );
      if (linkedTodo) {
        return {
          ...event,
          dueDate: linkedTodo.dueDate,
          isWorkSession: true,
          todoId: linkedTodo.id,
          // Use event's own completed status first to track independent work session completion
          completed: event.completed !== undefined ? event.completed : false
        };
      }
      return event;
    });
  }, [events, todos]);

  const handleToggleEventCompletion = (eventId: string, completed: boolean) => {
    const updatedEvents = events.map((e) => (e.id === eventId ? { ...e, completed } : e));
    setEvents(updatedEvents);
    localStorage.setItem('calendarEvents', JSON.stringify(updatedEvents));
    setSelectedEvent((prev) => {
      if (prev && prev.id === eventId) {
        return { ...prev, completed };
      }
      return prev;
    });

    if (completed) {
      const linkedTodo = todos.find((todo) =>
        (todo.scheduledSessions || []).some((session) => session.id === eventId)
      );

      if (linkedTodo && !linkedTodo.completed) {
        const sessionIds = (linkedTodo.scheduledSessions || []).map((s) => s.id);
        const allCompleted = sessionIds.every((sid) => {
          const ev = updatedEvents.find((e) => e.id === sid);
          return ev ? ev.completed === true : false;
        });

        if (allCompleted) {
          setWorkSessionTaskToComplete(linkedTodo);
        }
      }
    }
  };

  const handleConfirmTaskComplete = () => {
    if (!workSessionTaskToComplete) return;

    const updatedTodos = todos.map((t) => {
      if (t.id === workSessionTaskToComplete.id) {
        return { ...t, completed: true };
      }
      return t;
    });

    setTodos(updatedTodos);
    saveTasksV1(updatedTodos);
    
    try {
      confetti({
        particleCount: 150,
        spread: 80,
        origin: { y: 0.5 }
      });
      setTimeout(() => {
        confetti({
          particleCount: 100,
          spread: 100,
          origin: { y: 0.6 }
        });
      }, 250);
    } catch (err) {
      console.error('Confetti celebrate failed:', err);
    }

    setWorkSessionTaskToComplete(null);
  };

  // Handle toggling layout layers
  const handleToggleLayer = (layer: CalendarLayer) => {
    setActiveLayers((prev) => ({
      ...prev,
      [layer]: !prev[layer],
    }));
  };

  // Navigate back and forth based on current view step
  const navigatePrevious = () => {
    setCurrentDate((prev) => {
      const next = new Date(prev);
      if (currentView === 'Month') {
        next.setMonth(prev.getMonth() - 1);
      } else if (currentView === 'Week') {
        next.setDate(prev.getDate() - 7);
      } else {
        next.setDate(prev.getDate() - 1);
      }
      return next;
    });
  };

  const navigateNext = () => {
    setCurrentDate((prev) => {
      const next = new Date(prev);
      if (currentView === 'Month') {
        next.setMonth(prev.getMonth() + 1);
      } else if (currentView === 'Week') {
        next.setDate(prev.getDate() + 7);
      } else {
        next.setDate(prev.getDate() + 1);
      }
      return next;
    });
  };

  const jumpToToday = () => {
    setCurrentDate(new Date());
    loadTodos();
    setTodayClickCount((prev) => prev + 1);
  };

  // Save new calendar event or apply changes to existing one
  const handleSaveEvent = (eventData: Omit<CalendarEvent, 'id'> & { id?: string }) => {
    if (eventData.id) {
      // Editing Mode
      setEvents((prev) =>
        prev.map((e) =>
          e.id === eventData.id ? (eventData as CalendarEvent) : e
        )
      );
    } else {
      // Create Mode
      const newEvent: CalendarEvent = {
        ...eventData,
        id: crypto.randomUUID(),
      };
      setEvents((prev) => [...prev, newEvent]);
    }
    setEditingEvent(null);
    setAddingEventOnDate(undefined);
  };

  // Delete event action function
  function deleteEvent(eventId: string) {
    const updatedEvents = events.filter(event => event.id !== eventId);
    setEvents(updatedEvents);
    localStorage.setItem("calendarEvents", JSON.stringify(updatedEvents));
    setSelectedEvent(null);
    setIsEventDetailsOpen(false);
  }

  // Duplicate event action helper function
  const handleDuplicateEvent = (original: CalendarEvent) => {
    const duplicated: CalendarEvent = {
      title: original.title,
      layer: original.layer,
      startTime: original.startTime,
      endTime: original.endTime,
      notes: original.notes,
      isFixed: original.isFixed,
      date: '', // Force empty so they must choose a new date
      id: undefined as any // Ensure id is undefined so we enter create mode
    };
    setEditingEvent(duplicated);
    setIsEventModalOpen(true);
  };

  // Format header display label based on view context
  const getHeaderLabel = () => {
    if (currentView === 'Month') {
      return formatMonthYear(currentDate);
    } else if (currentView === 'Week') {
      const weekDates = [];
      const temp = new Date(currentDate);
      const day = temp.getDay();
      const diff = temp.getDate() - day;
      
      for (let i = 0; i < 7; i++) {
        const d = new Date(temp);
        d.setDate(diff + i);
        weekDates.push(d);
      }
      
      const start = weekDates[0];
      const end = weekDates[6];
      
      if (start.getMonth() === end.getMonth()) {
        return `${start.toLocaleDateString('en-US', { month: 'short' })} ${start.getFullYear()}`;
      } else if (start.getFullYear() === end.getFullYear()) {
        return `${start.toLocaleDateString('en-US', { month: 'short' })} &ndash; ${end.toLocaleDateString('en-US', { month: 'short' })} ${start.getFullYear()}`;
      } else {
        return `${start.toLocaleDateString('en-US', { month: 'short' })} ${start.getFullYear()} &ndash; ${end.toLocaleDateString('en-US', { month: 'short' })} ${end.getFullYear()}`;
      }
    } else {
      return currentDate.toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      });
    }
  };

  // Quick reset to restore original mock schedule
  const resetToDefaultEvents = () => {
    if (confirm('Do you want to reset the calendar to default layers, colors, and academic events?')) {
      const defaultL = [
        { id: 'No School', name: 'No School', color: '#64748b' },
        { id: 'ED 895', name: 'ED 895', color: '#1F4E79' },
        { id: 'EDL 830', name: 'EDL 830', color: '#047857' },
        { id: 'Other', name: 'Other', color: '#B45309' },
      ];
      setLayers(defaultL);
      setAppAccentColor('#0F172A');
      setEvents(DEFAULT_EVENTS);
      localStorage.setItem('calendarEvents', JSON.stringify(DEFAULT_EVENTS));
      localStorage.setItem('layer_calendar_custom_layers', JSON.stringify(defaultL));
      localStorage.setItem('layer_calendar_app_accent', '#0F172A');
      setActiveLayers({
        'No School': true,
        'ED 895': true,
        'EDL 830': true,
        'Other': true,
      });
    }
  };

  return (
    <div className="flex flex-col md:flex-row h-screen w-full bg-slate-50 text-slate-900 overflow-hidden" id="raw-app-root">
      
      {/* Sidebar Panel of Geometric Balance */}
      {isSidebarOpen && (
        <aside className="fixed inset-0 z-50 md:relative md:inset-auto md:z-auto w-full md:w-64 bg-white border-b md:border-b-0 md:border-r border-slate-200 flex flex-col p-6 shrink-0 h-[100dvh] md:h-full overflow-y-auto justify-between no-print" id="academic-sidebar">
          
          <div className="space-y-6 md:space-y-8 flex flex-col flex-1">
            {/* Brand Logo header */}
            <div className="flex items-center justify-between shrink-0">
              <div className="flex items-center space-x-2.5">
                <div 
                  className="w-8 h-8 rounded flex items-center justify-center text-white font-bold tracking-wider select-none shrink-0"
                  style={{ backgroundColor: appAccentColor }}
                >
                  A
                </div>
                <h1 className="text-xl font-bold tracking-tight text-slate-900" id="brand-title">
                  Academic Planner
                </h1>
              </div>
            </div>

            {/* Collapsible Action Button */}
            <button
               onClick={() => {
                 setIsSidebarOpen(false);
                 localStorage.setItem('layer_calendar_sidebar_open', 'false');
               }}
               className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-semibold text-slate-505 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-lg border border-slate-200 transition-colors cursor-pointer shrink-0"
               id="sidebar-close-btn"
               title="Close To-Do List"
               aria-label="Close To-Do List"
            >
               <span>←</span>
               <span>Close To-Do List</span>
            </button>

            {/* Mobile Actions Container (Highly visible without scrolling, matches theme design) */}
            <div className="block md:hidden space-y-2.5 pb-4 pt-1 border-b border-slate-100 shrink-0" id="mobile-sidebar-actions">
              <button
                onClick={() => {
                  setIsBuildTodoOpen(true);
                  setIsSidebarOpen(false); // Close sidebar on mobile so modal displays clearly
                }}
                className="w-full inline-flex items-center justify-center gap-2 px-3 py-3 text-white font-sans font-semibold rounded-lg shadow-sm active:scale-[0.98] hover:brightness-105 hover:shadow-md transition-all duration-200 cursor-pointer text-sm bg-emerald-600 hover:bg-emerald-700"
                title="Quickly add new assignments and tasks"
                id="btn-build-todo-mobile"
              >
                <Plus className="w-4 h-4" />
                <span>Task</span>
              </button>

              <button
                onClick={() => {
                  setEditingEvent(null);
                  setAddingEventOnDate(undefined);
                  setIsEventModalOpen(true);
                  setIsSidebarOpen(false); // Close sidebar on mobile
                }}
                className="w-full inline-flex items-center justify-center gap-2 px-3 py-3 text-white font-sans font-semibold rounded-lg shadow-sm active:scale-[0.98] hover:brightness-105 hover:shadow-md transition-all duration-200 cursor-pointer text-sm bg-blue-600 hover:bg-blue-700"
                id="main-add-event-btn-mobile"
                title="Create a new calendar event or class session"
              >
                <Plus className="w-4 h-4" />
                <span>Event</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  openTodoList();
                  setIsSidebarOpen(false); // Close sidebar on mobile
                }}
                className="w-full inline-flex items-center justify-center gap-2 px-3 py-3 text-white font-sans font-semibold rounded-lg shadow-sm active:scale-[0.98] hover:brightness-105 hover:shadow-md transition-all duration-200 cursor-pointer text-sm"
                style={{ backgroundColor: appAccentColor }}
                title="View To-Do List"
                aria-label="View To-Do List"
                id="btn-view-complete-todo-mobile"
              >
                <ClipboardList className="w-4 h-4" />
                <span>View To-Do List</span>
              </button>
            </div>

            {/* Active Layer Filters section */}
            <div className="space-y-4 shrink-0">
              <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-widest text-left">
                Layers
              </h2>
              <LayerToggles
                activeLayers={activeLayers}
                onToggleLayer={handleToggleLayer}
                layers={layers}
              />
            </div>

            {/* Setup reset defaults action helper */}
            <div className="pt-2 shrink-0">
              <button
                onClick={resetToDefaultEvents}
                className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-mono text-slate-400 hover:text-slate-700 bg-slate-50 hover:bg-slate-100 rounded-lg border border-slate-200/60 transition-colors cursor-pointer"
                title="Restore standard academic schedules"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Reset Default Layers
              </button>
            </div>

            {/* Mobile Account, Tasks & Settings block positioned at the bottom */}
            <div className="block md:hidden border-t border-slate-100 pt-4 pb-6 mt-auto space-y-3 font-sans shrink-0" id="mobile-sidebar-utilities">
              <h2 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest text-left mb-1.5">
                Account & Shortcuts
              </h2>
              <div className="flex flex-col gap-2">
                {/* Settings Trigger Button */}
                <button
                  onClick={() => {
                    setIsSettingsOpen(true);
                    setIsSidebarOpen(false); // Close sidebar
                  }}
                  className="w-full inline-flex items-center justify-center gap-2 px-3 py-2.5 h-[38px] text-xs font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg border border-slate-200 transition-colors cursor-pointer"
                  id="mobile-sidebar-settings"
                >
                  <Settings className="w-3.5 h-3.5" style={{ color: appAccentColor }} />
                  <span>⚙ Settings Panel</span>
                </button>

                {/* 3. User Cloud Profile Container */}
                <div className="mt-1">
                  {isAuthChecking ? (
                    <div className="text-[10px] text-slate-400 py-2 text-center font-mono">Checking cloud status...</div>
                  ) : !user ? (
                    <button
                      onClick={async () => {
                        setIsSidebarOpen(false);
                        await handleGoogleLogin();
                      }}
                      className="w-full inline-flex items-center justify-center gap-2 px-3 py-2.5 h-[38px] bg-indigo-650 bg-indigo-600 hover:bg-indigo-700 text-white active:scale-[0.98] rounded-lg text-xs font-bold shadow-3xs cursor-pointer transition-all"
                      id="mobile-sidebar-login"
                    >
                      <LogIn className="w-3.5 h-3.5" />
                      <span>Sync with Google Cloud</span>
                    </button>
                  ) : (
                    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2.5 text-left">
                      <div className="flex items-center gap-2">
                        {user.photoURL ? (
                          <img src={user.photoURL} alt="" referrerPolicy="no-referrer" className="w-8 h-8 rounded-full border border-slate-200" />
                        ) : (
                          <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center text-[10px] font-bold text-slate-700 border border-slate-200">
                            {user.displayName?.charAt(0) || user.email?.charAt(0).toUpperCase() || 'U'}
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-bold text-slate-950 truncate leading-snug">{user.displayName || "User profile"}</p>
                          <p className="text-[10px] text-slate-500 truncate leading-tight">{user.email}</p>
                        </div>
                      </div>

                      {/* Sync Indicator */}
                      <div className="flex flex-col gap-1.5">
                        <div className="flex items-center gap-1.5 py-1 text-[10px] font-bold text-slate-500 bg-slate-100/60 px-2 rounded border border-slate-200">
                          <span className={`w-1.5 h-1.5 rounded-full ${cloudSaveStatus.startsWith('Saved to cloud') || cloudSaveStatus.startsWith('Signed in') ? 'bg-emerald-500 animate-pulse' : (cloudSaveStatus.startsWith('Saving') || cloudSaveStatus.startsWith('Pending')) ? 'bg-amber-500 animate-ping' : cloudSaveStatus.toLowerCase().includes('quota') ? 'bg-amber-400 animate-pulse' : cloudSaveStatus.startsWith('Cloud save failed') ? 'bg-rose-500' : 'bg-slate-350'}`}></span>
                          <span className="font-mono text-[9px] tracking-wider truncate">Sync: {cloudSaveStatus}</span>
                        </div>
                        {cloudSaveStatus.toLowerCase().includes('quota') && (
                          <div className="px-2 py-2 border border-amber-200 bg-amber-50 text-amber-900 rounded text-[9.5px] leading-relaxed font-semibold">
                            <p className="text-amber-800 font-bold mb-1">⚠️ Spark Plan Quota Met</p>
                            <p className="text-slate-650 text-slate-600">Firestore database has reached its daily free limit. Changes remain saved locally on this device.</p>
                            <a 
                              href="https://console.firebase.google.com/project/gen-lang-client-0283047291/firestore/databases/ai-studio-2bfec3dd-14ac-4643-a944-1f51b3bdcded/data?openUpgradeDialog=true"
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex hover:underline text-[9px] text-[#2563EB] font-bold mt-1.5"
                            >
                              Upgrade in Console ↗
                            </a>
                          </div>
                        )}
                      </div>

                      <div className="grid grid-cols-2 gap-2 pt-1 border-t border-slate-200">
                        <button
                          onClick={() => {
                            handleExportBackup();
                            setIsSidebarOpen(false);
                          }}
                          className="w-full flex items-center justify-center gap-1 px-2 py-1.5 bg-white hover:bg-slate-100 border border-slate-200 rounded text-[10px] text-slate-700 transition-colors cursor-pointer font-bold"
                        >
                          <Download className="w-3.5 h-3.5 text-slate-500" />
                          <span>Export</span>
                        </button>

                        <button
                          onClick={async () => {
                            setIsSidebarOpen(false);
                            await handleSignOut();
                          }}
                          className="w-full flex items-center justify-center gap-1 px-2 py-1.5 bg-white hover:bg-rose-50 border border-slate-200 hover:border-rose-250 rounded text-[10px] text-rose-600 transition-colors cursor-pointer font-bold"
                        >
                          <LogOut className="w-3.5 h-3.5" />
                          <span>Sign Out</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Sidebar Action Center */}
          <div className="hidden md:flex flex-col pt-4 border-t border-slate-100 mt-auto space-y-2.5">
            <button
              onClick={() => setIsBuildTodoOpen(true)}
              className="w-full inline-flex items-center justify-center gap-2 px-3 py-3 text-white font-sans font-semibold rounded-lg shadow-sm active:scale-[0.98] hover:brightness-105 hover:shadow-md transition-all duration-200 cursor-pointer text-sm bg-emerald-600 hover:bg-emerald-700"
              title="Quickly add new assignments and tasks"
              id="btn-build-todo"
            >
              <Plus className="w-4 h-4" />
              <span>Task</span>
            </button>

            <button
              onClick={() => {
                setEditingEvent(null);
                setAddingEventOnDate(undefined);
                setIsEventModalOpen(true);
              }}
              className="w-full inline-flex items-center justify-center gap-2 px-3 py-3 text-white font-sans font-semibold rounded-lg shadow-sm active:scale-[0.98] hover:brightness-105 hover:shadow-md transition-all duration-200 cursor-pointer text-sm bg-blue-600 hover:bg-blue-700"
              id="main-add-event-btn"
              title="Create a new calendar event or class session"
            >
              <Plus className="w-4 h-4" />
              <span>Event</span>
            </button>

            <button
              type="button"
              onClick={openTodoList}
              className="w-full inline-flex items-center justify-center gap-2 px-3 py-3 text-white font-sans font-semibold rounded-lg shadow-sm active:scale-[0.98] hover:brightness-105 hover:shadow-md transition-all duration-200 cursor-pointer text-sm"
              style={{ backgroundColor: appAccentColor }}
              title="View To-Do List"
              aria-label="View To-Do List"
              id="btn-view-complete-todo"
            >
              <ClipboardList className="w-4 h-4" />
              <span>View To-Do List</span>
            </button>
          </div>

        </aside>
      )}

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
               {/* Header bar */}
        <header className={`bg-white shrink-0 no-print flex flex-col justify-start transition-all duration-350 ease-in-out mobile-calendar-header ${
          mobileHeaderOption === 'hidden' 
            ? 'hidden md:flex md:border-b md:border-slate-200 md:shadow-3xs' 
            : (isHeaderCollapsed && currentView !== 'Month')
              ? 'max-h-0 opacity-0 border-none shadow-none pointer-events-none md:max-h-[140px] md:opacity-100 md:pointer-events-auto md:border-b md:border-slate-200 md:shadow-3xs' 
              : mobileHeaderOption === 'compact' 
                ? 'max-h-[175px] opacity-100 border-b border-slate-200 shadow-3xs'
                : 'max-h-[500px] opacity-100 border-b border-slate-200 shadow-3xs'
        } overflow-hidden md:overflow-visible`}>
          
          {/* Mobile Layout (under 768px) */}
          {mobileHeaderOption !== 'hidden' && (
            <div className={`md:hidden flex flex-col bg-white transition-all duration-300 ${
              mobileHeaderOption === 'compact' ? 'p-2.5 gap-2' : 'p-4 gap-3'
            }`}>
              
              {mobileHeaderOption === 'full' ? (
                <>
                  {/* Title / Header Label on Mobile */}
                  <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                    <div className="flex items-center space-x-2">
                      <div 
                        className="w-7 h-7 rounded flex items-center justify-center text-white font-bold text-sm select-none shrink-0 font-sans"
                        style={{ backgroundColor: appAccentColor }}
                      >
                        A
                      </div>
                      <h1 className="text-sm font-bold tracking-tight text-slate-900">
                        Academic Planner
                      </h1>
                    </div>
                    <span
                      className="text-xs font-semibold text-slate-505 truncate"
                      id="calendar-header-title-mobile"
                      dangerouslySetInnerHTML={{ __html: getHeaderLabel() }}
                    />
                  </div>

                  {/* Row 1: Sidebar Toggle, Settings & Google Auth */}
                  <div className="flex items-center justify-center gap-3 flex-wrap relative">
                      {!isSidebarOpen ? (
                        <button
                          onClick={() => {
                            setIsSidebarOpen(true);
                            localStorage.setItem('layer_calendar_sidebar_open', 'true');
                          }}
                          className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 active:scale-[0.98] rounded-lg border border-slate-200 transition-colors cursor-pointer"
                          id="sidebar-open-btn-mobile"
                          title="Open To-Do List"
                          aria-label="Open To-Do List"
                        >
                          <span className="text-base">☰</span>
                          <span>Open To-Do List</span>
                        </button>
                      ) : (
                        <button
                          onClick={() => {
                            setIsSidebarOpen(false);
                            localStorage.setItem('layer_calendar_sidebar_open', 'false');
                          }}
                          className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 active:scale-[0.98] rounded-lg border border-slate-200 transition-colors cursor-pointer"
                          id="sidebar-close-btn-mobile"
                          title="Close To-Do List"
                          aria-label="Close To-Do List"
                        >
                          <span className="text-base">←</span>
                          <span>Close To-Do List</span>
                        </button>
                      )}
                      
                      <button
                        onClick={() => setIsSettingsOpen(true)}
                        className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 active:scale-[0.98] rounded-lg border border-slate-200 transition-colors cursor-pointer"
                        id="raw-nav-settings-btn-mobile"
                        title="Layer Settings"
                      >
                        <Settings className="w-4 h-4" style={{ color: appAccentColor }} />
                        <span>Settings</span>
                      </button>

                      {/* Mobile Auth Button */}
                      {isAuthChecking ? (
                        <span className="text-xs text-slate-400 font-sans">Checking...</span>
                      ) : !user ? (
                        <button
                          onClick={handleGoogleLogin}
                          className="min-h-[44px] inline-flex items-center justify-center gap-2 px-4 bg-indigo-600 text-white hover:bg-indigo-700 active:scale-[0.98] rounded-lg text-xs font-semibold shadow-xs cursor-pointer transition-all"
                          id="google-login-btn-mobile"
                          title="Sign in with Google to sync planner"
                        >
                          <LogIn className="w-4 h-4" />
                          <span>Cloud Save</span>
                        </button>
                      ) : (
                        <div className="relative inline-block text-left">
                          <button
                            onClick={() => setShowProfileMenu(prev => !prev)}
                            className="min-h-[44px] inline-flex items-center justify-center gap-2 px-3 py-1 bg-slate-100 border border-slate-200 hover:bg-slate-200 active:scale-[0.98] rounded-lg text-xs font-medium text-slate-800 cursor-pointer"
                            id="user-profile-btn-mobile"
                            title="User profile menu"
                          >
                            {user.photoURL ? (
                              <img src={user.photoURL} alt="" referrerPolicy="no-referrer" className="w-5 h-5 rounded-full border border-slate-300" />
                            ) : (
                              <div className="w-5 h-5 rounded-full bg-indigo-100 flex items-center justify-center text-[10px] font-bold text-indigo-700">
                                {user.displayName?.charAt(0) || user.email?.charAt(0).toUpperCase() || 'U'}
                              </div>
                            )}
                            <span className="truncate max-w-[85px] font-semibold">{user.displayName?.split(" ")[0] || "User"}</span>
                          </button>

                          {/* Dropdown Menu on Mobile */}
                          {showProfileMenu && (
                            <div 
                              className="absolute right-0 top-12 w-52 bg-white rounded-lg shadow-xl border border-slate-200 p-3 z-[100] animate-fade-in text-left font-sans"
                              id="profile-dropdown-mobile"
                            >
                              <div className="pb-2 border-b border-slate-100 flex items-center gap-2 mb-2">
                                {user.photoURL ? (
                                  <img src={user.photoURL} alt="" referrerPolicy="no-referrer" className="w-8 h-8 rounded-full border border-slate-200" />
                                ) : (
                                  <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center text-xs font-extrabold text-slate-700 border border-slate-200">
                                    {user.displayName?.charAt(0) || user.email?.charAt(0).toUpperCase() || 'U'}
                                  </div>
                                )}
                                <div className="min-w-0 flex-1">
                                  <p className="text-xs font-bold text-slate-900 truncate">{user.displayName || "User"}</p>
                                  <p className="text-[10px] text-slate-500 truncate">{user.email}</p>
                                </div>
                              </div>

                              <div className="flex flex-col gap-1">
                                <div className="px-2 py-1 text-[10px] uppercase tracking-wider font-extrabold text-green-700 bg-green-55 bg-green-50 rounded flex items-center gap-1 mb-1">
                                  <Cloud className="w-3 h-3 text-green-600" />
                                  <span>Synced to Cloud</span>
                                </div>

                                <button
                                  onClick={() => {
                                    handleExportBackup();
                                    setShowProfileMenu(false);
                                  }}
                                  className="w-full text-left flex items-center gap-2 px-2 py-1.5 text-xs text-slate-700 hover:bg-slate-100 rounded transition-colors cursor-pointer font-semibold"
                                >
                                  <Download className="w-3.5 h-3.5 text-slate-500" />
                                  <span>Export Backup</span>
                                </button>

                                <button
                                  onClick={async () => {
                                    setShowProfileMenu(false);
                                    await handleSignOut();
                                  }}
                                  className="w-full text-left flex items-center gap-2 px-2 py-1.5 text-xs text-rose-600 hover:bg-rose-50 rounded transition-colors cursor-pointer font-semibold"
                                >
                                  <LogOut className="w-3.5 h-3.5" />
                                  <span>Sign Out</span>
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                  </div>

                  {/* Cloud Sync Status indicator */}
                  <div className="self-center text-[10px] font-medium text-slate-505 text-slate-500 py-1 border border-slate-100 bg-slate-50 px-3.5 rounded-full flex items-center justify-center gap-1.5 font-mono shadow-3xs select-none">
                    <span className={`w-1.5 h-1.5 rounded-full ${cloudSaveStatus.startsWith('Saved to cloud') || cloudSaveStatus.startsWith('Signed in') ? 'bg-emerald-500 animate-pulse' : (cloudSaveStatus.startsWith('Saving') || cloudSaveStatus.startsWith('Pending')) ? 'bg-amber-500 animate-ping' : cloudSaveStatus.toLowerCase().includes('quota') ? 'bg-amber-400 animate-pulse' : cloudSaveStatus.startsWith('Cloud save failed') ? 'bg-rose-500' : 'bg-slate-350'}`}></span>
                    <span>Sync status: {cloudSaveStatus}</span>
                  </div>

                  {/* Row 2: Navigation controls */}
                  <div className="flex items-center justify-center gap-3 flex-wrap">
                    <button
                      onClick={navigatePrevious}
                      className="min-h-[44px] min-w-[44px] p-2.5 bg-slate-100 hover:bg-slate-205 active:scale-[0.98] rounded-lg border border-slate-200 text-slate-600 transition-colors cursor-pointer flex items-center justify-center"
                      id="raw-nav-prev-btn-mobile"
                      title="Previous"
                    >
                      <ChevronLeft className="w-5 h-5" />
                    </button>
                    
                    <button
                      onClick={jumpToToday}
                      className="min-h-[44px] px-5 py-2.5 text-xs font-bold bg-white hover:bg-slate-50 active:scale-[0.98] border border-slate-250 rounded-lg text-slate-700 transition-all cursor-pointer flex items-center justify-center shrink-0 shadow-3xs"
                      id="raw-nav-today-btn-mobile"
                    >
                      Today
                    </button>
                    
                    <button
                      onClick={navigateNext}
                      className="min-h-[44px] min-w-[44px] p-2.5 bg-slate-100 hover:bg-slate-205 active:scale-[0.98] rounded-lg border border-slate-200 text-slate-600 transition-colors cursor-pointer flex items-center justify-center"
                      id="raw-nav-next-btn-mobile"
                      title="Next"
                    >
                      <ChevronRight className="w-5 h-5" />
                    </button>
                  </div>

                  {/* Row 3: Month / Week / Day toggle */}
                  <div className="flex justify-center bg-slate-100 p-1 rounded-lg max-w-sm mx-auto w-full view-tabs" id="view-selector-tabs-mobile">
                    {(['Month', 'Week', 'Day'] as CalendarView[]).map((view) => (
                      <button
                        key={view}
                        id={`view-tab-mobile-${view.toLowerCase()}`}
                        onClick={() => {
                          setCurrentView(view);
                          setCurrentDate(new Date());
                          setIsViewTodoOpen(false);
                        }}
                        className={`flex-1 min-h-[44px] py-1.5 text-xs font-bold rounded-md transition-all duration-150 cursor-pointer flex items-center justify-center ${
                          currentView === view && !isViewTodoOpen
                            ? 'bg-white text-slate-900 shadow-sm font-extrabold'
                            : 'text-slate-600 hover:text-slate-950'
                        }`}
                      >
                        {view}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  {/* Compact Header Layout (Default focus mode) */}
                  {/* Row 1: [☰] Academic Planner [⚙] */}
                  <div className="flex items-center justify-between px-1.5 w-full" id="compact-row-1">
                    <button
                      onClick={() => {
                        setIsSidebarOpen(true);
                        localStorage.setItem('layer_calendar_sidebar_open', 'true');
                      }}
                      className="p-1.5 text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md border border-slate-200 transition-colors cursor-pointer"
                      id="compact-sidebar-toggle-mobile"
                      title="Open To-Do List"
                      aria-label="Open To-Do List"
                    >
                      <span className="text-sm font-bold leading-none">☰</span>
                    </button>

                    <div className="flex items-center space-x-1.5 select-none" id="compact-header-title">
                      <div 
                        className="w-5.5 h-5.5 rounded flex items-center justify-center text-white font-bold text-[9px] select-none shrink-0 font-sans"
                        style={{ backgroundColor: appAccentColor }}
                      >
                        A
                      </div>
                      <span className="text-xs font-bold tracking-tight text-slate-900">Academic Planner</span>
                    </div>

                    <button
                      onClick={() => setIsSettingsOpen(true)}
                      className="p-1.5 text-slate-600 bg-slate-100 hover:bg-slate-205 hover:bg-slate-200 rounded-md border border-slate-200 transition-colors cursor-pointer"
                      id="compact-settings-btn-mobile"
                      title="Planner Settings"
                    >
                      <Settings className="w-3.5 h-3.5" style={{ color: appAccentColor }} />
                    </button>
                  </div>

                  {/* Row 2: [<] Today [>] */}
                  <div className="flex items-center justify-between gap-1.5 w-full font-sans" id="compact-row-2">
                    <button
                      onClick={navigatePrevious}
                      className="h-[36px] px-3 bg-slate-100 hover:bg-slate-200 active:scale-[0.98] rounded-md border border-slate-200 text-slate-650 transition-colors cursor-pointer flex items-center justify-center text-xs font-semibold"
                      id="compact-nav-prev-btn-mobile"
                      title="Previous"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    
                    <button
                      onClick={jumpToToday}
                      className="flex-1 h-[36px] text-xs font-bold bg-white hover:bg-slate-50 active:scale-[0.98] border border-slate-250 rounded-md text-slate-700 transition-all cursor-pointer flex items-center justify-center shadow-3xs"
                      id="compact-nav-today-btn-mobile"
                    >
                      Today
                    </button>
                    
                    <button
                      onClick={navigateNext}
                      className="h-[36px] px-3 bg-slate-100 hover:bg-slate-200 active:scale-[0.98] rounded-md border border-slate-200 text-slate-650 transition-colors cursor-pointer flex items-center justify-center text-xs font-semibold"
                      id="compact-nav-next-btn-mobile"
                      title="Next"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>

                  {/* Row 3: [Month] [Week] [Day] */}
                  <div className="flex justify-center bg-slate-100 p-0.5 rounded-md w-full font-sans animate-fade-in view-tabs" id="compact-view-tabs-mobile">
                    {(['Month', 'Week', 'Day'] as CalendarView[]).map((view) => (
                      <button
                        key={view}
                        id={`compact-view-tab-mobile-${view.toLowerCase()}`}
                        onClick={() => {
                          setCurrentView(view);
                          setCurrentDate(new Date());
                          setIsViewTodoOpen(false);
                        }}
                        className={`flex-1 h-[34px] text-xs font-bold rounded-sm transition-all duration-150 cursor-pointer flex items-center justify-center ${
                          currentView === view && !isViewTodoOpen
                            ? 'bg-white text-slate-900 shadow-3xs font-extrabold'
                            : 'text-slate-605 text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {view}
                      </button>
                    ))}
                  </div>
                </>
              )}

            </div>
          )}

          {/* Desktop Layout (768px and up) */}
          <div className="hidden md:flex h-20 items-center justify-between px-6">
            <div className="flex items-center space-x-4 md:space-x-6 min-w-0">
              {!isSidebarOpen && (
                <>
                  <div className="flex items-center space-x-2 mr-2 shrink-0">
                    <div 
                      className="w-8 h-8 rounded flex items-center justify-center text-white font-bold tracking-wider select-none shrink-0 font-sans"
                      style={{ backgroundColor: appAccentColor }}
                    >
                      A
                    </div>
                    <span className="text-lg font-bold tracking-tight text-slate-905 hidden lg:inline-block">Academic Planner</span>
                  </div>
                  <button
                    onClick={() => {
                      setIsSidebarOpen(true);
                      localStorage.setItem('layer_calendar_sidebar_open', 'true');
                    }}
                    className="inline-flex items-center gap-2 px-3 py-2 text-xs md:text-sm font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg border border-slate-200 transition-colors cursor-pointer shrink-0"
                    id="sidebar-open-btn"
                    title="Open To-Do List"
                    aria-label="Open To-Do List"
                  >
                    <span>☰</span>
                    <span>Open To-Do List</span>
                  </button>
                </>
              )}
              <h2
                className="text-lg md:text-2xl font-bold text-slate-900 truncate"
                id="calendar-header-title text"
                dangerouslySetInnerHTML={{ __html: getHeaderLabel() }}
              />
              
              {/* View Switching Tab capsule */}
              <div className="flex bg-slate-100 p-1 rounded-lg shrink-0" id="view-selector-tabs">
                {(['Month', 'Week', 'Day'] as CalendarView[]).map((view) => (
                  <button
                    key={view}
                    id={`view-tab-${view.toLowerCase()}`}
                    onClick={() => {
                      setCurrentView(view);
                      setCurrentDate(new Date());
                      setIsViewTodoOpen(false);
                    }}
                    className={`px-3 md:px-4 py-1.5 text-xs md:text-sm font-medium rounded-md transition-all duration-150 cursor-pointer ${
                      currentView === view && !isViewTodoOpen
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-950'
                    }`}
                  >
                    {view}
                  </button>
                ))}
              </div>
            </div>

            {/* Navigation Controls */}
            <div className="flex items-center space-x-2 shrink-0 relative">
              <button
                onClick={navigatePrevious}
                className="p-2 hover:bg-slate-50 rounded-full border border-slate-200 text-slate-600 transition-colors cursor-pointer"
                id="raw-nav-prev-btn"
                title="Previous"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
              <button
                onClick={jumpToToday}
                className="px-3 md:px-4 py-2 text-xs md:text-sm font-semibold border border-slate-200 rounded-lg hover:bg-slate-50 text-slate-700 transition-all cursor-pointer"
                id="raw-nav-today-btn"
              >
                Today
              </button>
              <button
                onClick={navigateNext}
                className="p-2 hover:bg-slate-50 rounded-full border border-slate-200 text-slate-600 transition-colors cursor-pointer"
                id="raw-nav-next-btn"
                title="Next"
              >
                <ChevronRight className="w-5 h-5" />
              </button>
              <button
                onClick={() => setIsSettingsOpen(true)}
                className="p-2 hover:bg-slate-50 rounded-full border border-slate-200 text-slate-600 transition-colors cursor-pointer"
                id="raw-nav-settings-btn"
                title="Layer Settings"
              >
                <Settings className="w-5 h-5" style={{ color: appAccentColor }} />
              </button>

              {/* Desktop Auth Section */}
              <div className="border-l border-slate-200 pl-3 ml-2 flex flex-col items-end shrink-0">
                <div className="flex items-center">
                  {isAuthChecking ? (
                    <span className="text-xs text-slate-400 font-sans px-2">Checking...</span>
                  ) : !user ? (
                    <button
                      onClick={handleGoogleLogin}
                      className="inline-flex items-center gap-2 px-3.5 py-2 bg-indigo-600 text-white hover:bg-indigo-700 active:scale-[0.98] rounded-lg text-xs font-semibold shadow-xs cursor-pointer transition-all"
                      id="google-login-btn-desktop"
                      title="Sign in with Google to sync planner"
                    >
                      <LogIn className="w-4 h-4" />
                      <span>Cloud Saving</span>
                    </button>
                  ) : (
                    <div className="relative inline-block text-left">
                      <button
                        onClick={() => setShowProfileMenu(prev => !prev)}
                        className="inline-flex items-center gap-2 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 active:scale-[0.98] rounded-lg text-xs font-semibold text-slate-800 cursor-pointer border border-slate-200"
                        id="user-profile-btn-desktop"
                        title="User account settings"
                      >
                        {user.photoURL ? (
                          <img src={user.photoURL} alt="" referrerPolicy="no-referrer" className="w-5 h-5 rounded-full border border-slate-300" />
                        ) : (
                          <div className="w-5 h-5 rounded-full bg-indigo-100 flex items-center justify-center text-[10px] font-bold text-indigo-700">
                            {user.displayName?.charAt(0) || user.email?.charAt(0).toUpperCase() || 'U'}
                          </div>
                        )}
                        <span className="truncate max-w-[105px] font-semibold">{user.displayName || "Logged In"}</span>
                      </button>

                      {/* Dropdown Menu on Desktop */}
                      {showProfileMenu && (
                        <div 
                          className="absolute right-0 top-12 w-56 bg-white rounded-lg shadow-xl border border-slate-200 p-3 z-[100] animate-fade-in text-left font-sans"
                          id="profile-dropdown-desktop"
                        >
                          <div className="pb-2 border-b border-slate-100 flex items-center gap-2 mb-2">
                            {user.photoURL ? (
                              <img src={user.photoURL} alt="" referrerPolicy="no-referrer" className="w-8 h-8 rounded-full border border-slate-200" />
                            ) : (
                              <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center text-xs font-extrabold text-slate-700 border border-slate-200">
                                {user.displayName?.charAt(0) || user.email?.charAt(0).toUpperCase() || 'U'}
                              </div>
                            )}
                            <div className="min-w-0 flex-1">
                              <p className="text-xs font-bold text-slate-900 truncate font-semibold">{user.displayName || "User"}</p>
                              <p className="text-[10px] text-slate-500 truncate">{user.email}</p>
                            </div>
                          </div>

                          <div className="flex flex-col gap-1">
                            {cloudSaveStatus.toLowerCase().includes('quota') ? (
                              <div className="px-2 py-2 mb-2 border border-amber-200 bg-amber-50 text-amber-900 rounded text-[9.5px] leading-relaxed font-semibold">
                                <p className="text-amber-800 font-bold mb-1">⚠️ Spark Plan Quota Met</p>
                                <p className="mb-1 text-slate-600">The Firestore daily write queue has reached its free limit. Moving gracefully to local/offline persistence on your device.</p>
                                <a 
                                  href="https://console.firebase.google.com/project/gen-lang-client-0283047291/firestore/databases/ai-studio-2bfec3dd-14ac-4643-a944-1f51b3bdcded/data?openUpgradeDialog=true"
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex hover:underline text-[9px] text-[#2563EB] font-bold mt-1"
                                >
                                  Upgrade / View Database Limits ↗
                                </a>
                              </div>
                            ) : (
                              <div className="px-2 py-1 text-[10px] uppercase tracking-wider font-extrabold text-green-700 bg-green-50 rounded flex items-center gap-1 mb-1">
                                <Cloud className="w-3 h-3 text-green-600" />
                                <span>Synced to Cloud</span>
                              </div>
                            )}

                            <button
                              onClick={() => {
                                handleExportBackup();
                                setShowProfileMenu(false);
                              }}
                              className="w-full text-left flex items-center gap-2 px-2 py-1.5 text-xs text-slate-700 hover:bg-slate-100 rounded transition-colors cursor-pointer font-semibold"
                            >
                              <Download className="w-3.5 h-3.5 text-slate-500" />
                              <span>Export Backup</span>
                            </button>

                            <button
                              onClick={async () => {
                                setShowProfileMenu(false);
                                await handleSignOut();
                              }}
                              className="w-full text-left flex items-center gap-2 px-2 py-1.5 text-xs text-rose-600 hover:bg-rose-50 rounded transition-colors cursor-pointer font-semibold"
                            >
                              <LogOut className="w-3.5 h-3.5" />
                              <span>Sign Out</span>
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                
                {/* Desktop Cloud Sync Status indicator */}
                <div className="flex items-center gap-1 mt-1 font-mono select-none">
                  <span className={`w-1 h-1 rounded-full ${cloudSaveStatus.startsWith('Saved to cloud') || cloudSaveStatus.startsWith('Signed in') ? 'bg-emerald-500 animate-pulse' : (cloudSaveStatus.startsWith('Saving') || cloudSaveStatus.startsWith('Pending')) ? 'bg-amber-500 animate-ping' : cloudSaveStatus.toLowerCase().includes('quota') ? 'bg-amber-400 animate-pulse' : cloudSaveStatus.startsWith('Cloud save failed') ? 'bg-rose-500' : 'bg-slate-355 bg-slate-300'}`}></span>
                  <span className="text-[10px] font-semibold text-slate-400 select-none tracking-wider font-mono">
                    {cloudSaveStatus}
                  </span>
                </div>
              </div>
            </div>
          </div>

        </header>

        {showRecoveryBanner && (
          <div className="bg-amber-50 border-b border-amber-200 px-6 py-3 flex items-center justify-between text-amber-950 shrink-0 select-none animate-fade-in">
            <div className="flex items-center gap-2 text-sm font-medium">
              <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
              <span>Existing tasks from a previous session were found in legacy storage. Would you like to restore them?</span>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <button
                onClick={handleRestoreLegacyTodos}
                className="px-4 py-1.5 bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold rounded-md shadow-sm transition-colors cursor-pointer"
              >
                Restore Tasks
              </button>
              <button
                onClick={() => setShowRecoveryBanner(false)}
                className="text-xs font-medium text-amber-600 hover:text-amber-800 transition-colors cursor-pointer"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {/* View Presentation Grid Container */}
        <div className={`flex-1 ${currentView === 'Month' ? 'overflow-y-auto month-view-scroll' : 'overflow-hidden md:overflow-y-auto'} p-1.5 md:p-6 bg-slate-50/50 custom-scrollbar calendar-scroll-container mobile-calendar-scroll calendar-grid`} id="calendar-render-panel" onScroll={handleScroll}>
          {currentView === 'Month' && (
            <CalendarMonthView
              currentDate={currentDate}
              events={combinedEvents}
              activeLayers={activeLayers}
              layers={layers}
              todos={todos}
              onTodoClick={(todoId) => {
                setSelectedTodoId(todoId);
                setIsViewTodoOpen(true);
              }}
              onEventClick={(ev) => {
                setSelectedEvent(ev);
                setIsEventDetailsOpen(true);
              }}
              onDayClick={(date) => {
                setAddingEventOnDate(date);
                setEditingEvent(null);
                setIsEventModalOpen(true);
              }}
              todayClickCount={todayClickCount}
            />
          )}

          {currentView === 'Week' && (
            <CalendarWeekView
              currentDate={currentDate}
              events={combinedEvents}
              activeLayers={activeLayers}
              layers={layers}
              todos={todos}
              onEventClick={(ev) => {
                setSelectedEvent(ev);
                setIsEventDetailsOpen(true);
              }}
              onDayClick={(date) => {
                setAddingEventOnDate(date);
                setEditingEvent(null);
                setIsEventModalOpen(true);
              }}
              onTodoClick={(todoId) => {
                setSelectedTodoId(todoId);
                setIsViewTodoOpen(true);
              }}
              todayClickCount={todayClickCount}
              hideDueItems={hideDueItems}
              onToggleHideDueItems={() => setHideDueItems((prev) => !prev)}
            />
          )}

          {currentView === 'Day' && (
            <CalendarDayView
              currentDate={currentDate}
              events={combinedEvents}
              activeLayers={activeLayers}
              layers={layers}
              todos={todos}
              onEventClick={(ev) => {
                setSelectedEvent(ev);
                setIsEventDetailsOpen(true);
              }}
              onDayClick={(date) => {
                setAddingEventOnDate(date);
                setEditingEvent(null);
                setIsEventModalOpen(true);
              }}
              onTodoClick={(todoId) => {
                setSelectedTodoId(todoId);
                setIsViewTodoOpen(true);
              }}
              todayClickCount={todayClickCount}
              hideDueItems={hideDueItems}
              onToggleHideDueItems={() => setHideDueItems((prev) => !prev)}
            />
          )}
        </div>

      </main>

      {/* Add / Edit Popup Form Modal */}
      <EventModal
        isOpen={isEventModalOpen}
        onClose={() => {
          setIsEventModalOpen(false);
          setEditingEvent(null);
          setAddingEventOnDate(undefined);
        }}
        onSave={handleSaveEvent}
        initialEvent={editingEvent}
        defaultDate={addingEventOnDate}
        layers={layers}
      />

      {/* Detailed Viewer Modal */}
      <EventDetailModal
        isOpen={isEventDetailsOpen}
        selectedEvent={selectedEvent}
        onClose={() => {
          setIsEventDetailsOpen(false);
          setSelectedEvent(null);
        }}
        onEdit={(ev) => {
          setEditingEvent(ev);
          setIsEventModalOpen(true);
        }}
        onDuplicate={handleDuplicateEvent}
        deleteEvent={deleteEvent}
        layers={layers}
        todos={todos}
        events={events}
        onToggleCompletion={handleToggleEventCompletion}
      />

      {/* Build To-Do Form Form Modal */}
      <BuildTodoModal
        isOpen={isBuildTodoOpen}
        onClose={() => setIsBuildTodoOpen(false)}
        onTaskAdded={loadTodos}
        layers={layers}
        events={events}
        setEvents={setEvents}
      />

      {/* View Complete To-Do Card List Modal */}
      <ViewTodoModal
        isOpen={isViewTodoOpen}
        onClose={() => {
          setIsViewTodoOpen(false);
          setSelectedTodoId(null);
        }}
        onListUpdated={loadTodos}
        calendarEvents={events}
        setCalendarEvents={setEvents}
        layers={layers}
        initialSelectedTodoId={selectedTodoId}
      />

      {/* Settings management modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        layers={layers}
        onSaveLayers={handleSaveLayers}
        appAccentColor={appAccentColor}
        events={events}
        onListUpdated={loadTodos}
        mobileHeaderOption={mobileHeaderOption}
        onSaveMobileHeaderOption={setMobileHeaderOption}
      />

      {/* Task completion prompt modal */}
      {workSessionTaskToComplete && (
        <div 
          className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-[100] animate-fade-in"
          id="task-complete-prompt-backdrop"
        >
          <div 
            className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-sm p-6 text-center space-y-4 relative transform transition-all animate-scale-up"
            id="task-complete-prompt-container"
          >
            {/* Celebrate graphics icon */}
            <div className="flex justify-center">
              <div className="w-14 h-14 bg-emerald-100 rounded-full flex items-center justify-center animate-bounce">
                <Check className="w-7 h-7 text-emerald-600 stroke-[3]" />
              </div>
            </div>

            {/* Typography pairings */}
            <div className="space-y-2">
              <h3 className="text-lg font-bold text-slate-900 leading-snug" id="task-complete-prompt-title">
                Sessions Completed!
              </h3>
              <p className="text-sm text-slate-600 leading-relaxed text-left md:text-center" id="task-complete-prompt-message">
                You completed all scheduled work sessions for <strong className="text-slate-800">"{workSessionTaskToComplete.title}"</strong>.<br />
                Would you like to mark the task complete on your To-Do List?
              </p>
            </div>

            {/* Interactive Actions Grid */}
            <div className="flex flex-col gap-2 pt-2">
              <button
                type="button"
                onClick={handleConfirmTaskComplete}
                className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold rounded-lg transition-colors cursor-pointer shadow-sm"
                id="task-complete-confirm-yes-btn"
              >
                Yes, Complete Task
              </button>
              <button
                type="button"
                onClick={() => setWorkSessionTaskToComplete(null)}
                className="w-full py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-bold rounded-lg transition-colors cursor-pointer border border-slate-200"
                id="task-complete-confirm-no-btn"
              >
                Not Yet
              </button>
            </div>
          </div>
        </div>
      )}

      {/* First-login Migration Prompt Modal */}
      {showMigrationPrompt && (
        <div 
          className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-[110] animate-fade-in font-sans"
          id="migration-prompt-backdrop"
        >
          <div 
            className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-md p-6 text-center space-y-5 transform transition-all animate-scale-up"
            id="migration-prompt-container"
          >
            <div className="flex justify-center">
              <div className="w-12 h-12 bg-indigo-100 rounded-full flex items-center justify-center">
                <Cloud className="w-6 h-6 text-indigo-600 animate-pulse" />
              </div>
            </div>

            <div className="space-y-2">
              <h3 className="text-base font-bold text-slate-900 leading-snug uppercase tracking-wider" id="migration-prompt-title">
                Cloud Sync Initialization
              </h3>
              <p className="text-sm text-slate-605 leading-relaxed text-left md:text-center animate-fade-in text-slate-605" id="migration-prompt-description">
                Do you want to upload your current browser planner data (calendar events, tasks, layers, custom colors) to your Google account?
              </p>
            </div>

            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-left space-y-1">
              <span className="text-[10px] font-extrabold uppercase tracking-wide text-slate-500 block">This will migrate:</span>
              <ul className="text-xs text-slate-605 space-y-0.5 list-disc pl-4 text-slate-600">
                <li>Assignments, chores, and work tasks</li>
                <li>Calendar classes, holidays, and fixed events</li>
                <li>Academic layer configurations and custom app designs</li>
              </ul>
            </div>

            <div className="flex flex-col gap-2 pt-1">
              <button
                type="button"
                disabled={isMigrating}
                onClick={handleMigrateData}
                className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-bold rounded-lg transition-colors cursor-pointer shadow-sm flex items-center justify-center gap-2"
                id="migration-confirm-yes-btn"
              >
                {isMigrating ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Migrating Current Plan...</span>
                  </>
                ) : (
                  <span>Yes, Import My Planner Data</span>
                )}
              </button>
              <button
                type="button"
                disabled={isMigrating}
                onClick={handleSkipMigration}
                className="w-full py-2.5 bg-slate-100 hover:bg-slate-202 text-slate-700 text-sm font-bold rounded-lg transition-colors cursor-pointer border border-slate-200 hover:bg-slate-200"
                id="migration-confirm-no-btn"
              >
                No, Start Fresh / Load Cloud Data
              </button>
            </div>
            <p className="text-[10px] text-slate-400">
              * Local storage is kept as an offline copy backup.
            </p>
          </div>
        </div>
      )}

      {/* Cloud Sync Conflict Resolution Modal */}
      {showSyncConflictModal && pendingCloudData && (
        <div 
          className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-[120] animate-fade-in font-sans"
          id="sync-conflict-backdrop"
        >
          <div 
            className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-lg p-6 space-y-5 transform transition-all animate-scale-up"
            id="sync-conflict-container"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-amber-100 rounded-full flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5 text-amber-600" />
              </div>
              <div className="text-left">
                <h3 className="text-base font-bold text-slate-900 leading-snug">
                  Sync Conflict Detected
                </h3>
                <p className="text-xs text-slate-500">
                  Data in your Google Account and this browser differ.
                </p>
              </div>
            </div>

            <div className="text-sm text-slate-700 font-medium text-left">
              Which data do you want to keep?
            </div>

            <div className="grid grid-cols-1 gap-3 pt-1">
              {/* Option 1: Use Cloud Data */}
              <button
                type="button"
                onClick={handleConflictUseCloud}
                className="group flex items-start gap-3 p-3.5 rounded-lg border border-slate-200 hover:border-indigo-500 hover:bg-slate-50 transition-all text-left cursor-pointer"
                id="conflict-use-cloud-btn"
              >
                <Cloud className="w-5 h-5 text-indigo-600 shrink-0 mt-0.5" />
                <div>
                  <div className="text-xs font-bold text-slate-900 group-hover:text-indigo-600">Use Cloud Data</div>
                  <div className="text-[11px] text-slate-500 mt-0.5">
                    Overwrite local browser data with cloud planner details. Prevents older local states from corrupting newer devices.
                  </div>
                </div>
              </button>

              {/* Option 2: Upload local to Cloud */}
              <button
                type="button"
                onClick={handleConflictUploadLocal}
                className="group flex items-start gap-3 p-3.5 rounded-lg border border-slate-200 hover:border-emerald-500 hover:bg-slate-50 transition-all text-left cursor-pointer"
                id="conflict-upload-local-btn"
              >
                <Download className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5 rotate-180" />
                <div>
                  <div className="text-xs font-bold text-slate-900 group-hover:text-emerald-600">Upload This Device's Data to Cloud</div>
                  <div className="text-[11px] text-slate-500 mt-0.5">
                    Replace your cloud backup document with this browser's active planner details.
                  </div>
                </div>
              </button>

              {/* Option 3: Merge Both */}
              <button
                type="button"
                onClick={handleConflictMergeBoth}
                className="group flex items-start gap-3 p-3.5 rounded-lg border border-indigo-200 bg-indigo-50/30 hover:bg-indigo-50 hover:border-indigo-500 transition-all text-left cursor-pointer"
                id="conflict-merge-btn"
              >
                <RefreshCw className="w-5 h-5 text-indigo-600 shrink-0 mt-0.5" />
                <div>
                  <div className="text-xs font-bold text-indigo-900">Merge Both (Recommended)</div>
                  <div className="text-[11px] text-slate-600 mt-0.5">
                    De-duplicate and merge calendar class rosters, tasks lists, checklists, and active schedules onto both devices.
                  </div>
                </div>
              </button>
            </div>

            <div className="pt-2 text-[10px] text-slate-400 text-center">
              * Choosing any option automatically initializes real-time multi-device cloud synchronization.
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
