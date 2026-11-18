//! Kernel-aware view of FreeRTOS: tasks, their states and stacks, read from
//! the simulated memory with the ELF's symbols (no firmware changes, like a
//! debugger's RTOS plug-in).
//!
//! Layout assumptions (FreeRTOS V10/V11, single core, no MPU wrappers):
//! `List_t` is 20 bytes (mini list end item), `ListItem_t` 20 bytes, and a
//! TCB starts with `pxTopOfStack`, `xStateListItem`, `xEventListItem`,
//! `uxPriority`, `pxStack`, `pcTaskName[...]`. The name length and the
//! optional `pxEndOfStack` are detected from the idle task's TCB.

use simucleo_elf::FirmwareImage;

const LIST_SIZE: u32 = 20;
/// Offsets inside a TCB.
const TCB_STATE_ITEM: u32 = 4;
const TCB_EVENT_ITEM: u32 = 24;
const TCB_PRIORITY: u32 = 44;
const TCB_STACK: u32 = 48;
const TCB_NAME: u32 = 52;
/// Inside a `ListItem_t`.
const ITEM_NEXT: u32 = 4;
const ITEM_OWNER: u32 = 12;
const ITEM_CONTAINER: u32 = 16;
/// `tskSTACK_FILL_BYTE`: unused stack when overflow checking or the trace
/// facility is on.
const STACK_FILL: u8 = 0xA5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskState {
    Running,
    Ready,
    Blocked,
    Suspended,
    Deleted,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInfo {
    /// TCB address (the task handle).
    pub tcb: u32,
    pub name: String,
    pub state: TaskState,
    pub priority: u32,
    /// Lowest address of the stack (`pxStack`).
    pub stack_base: u32,
    /// Stack size in bytes, when the TCB records the stack end.
    pub stack_size: Option<u32>,
    /// Bytes never used so far (high-water mark), when the stack is filled
    /// with the check pattern.
    pub stack_free_min: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RtosSnapshot {
    pub kernel: &'static str,
    /// API layer the firmware uses on top of the kernel, if recognised.
    /// With ST's CMSIS-RTOS2 wrapper, kernel priority = osPriority − 1.
    pub api: Option<&'static str>,
    pub scheduler_running: bool,
    pub tick: u32,
    pub current: Option<u32>,
    pub tasks: Vec<TaskInfo>,
}

/// Addresses of the FreeRTOS kernel objects in a firmware image.
#[derive(Debug, Clone)]
pub struct FreeRtos {
    pub current_tcb: u32,
    ready_lists: u32,
    priorities: u32,
    other_lists: Vec<(u32, TaskState)>,
    scheduler_running: Option<u32>,
    tick_count: Option<u32>,
    idle_handle: Option<u32>,
    cmsis_os2: bool,
}

impl FreeRtos {
    /// Find the kernel in the firmware's symbols.
    pub fn detect(fw: &FirmwareImage) -> Option<Self> {
        let current_tcb = fw.symbol("pxCurrentTCB")?;
        let (ready_lists, size) = fw.symbol_with_size("pxReadyTasksLists")?;
        let priorities = (size / LIST_SIZE).clamp(1, 256);
        let mut other_lists = Vec::new();
        for (name, state) in [
            ("xDelayedTaskList1", TaskState::Blocked),
            ("xDelayedTaskList2", TaskState::Blocked),
            ("xPendingReadyList", TaskState::Ready),
            ("xSuspendedTaskList", TaskState::Suspended),
            ("xTasksWaitingTermination", TaskState::Deleted),
        ] {
            if let Some(a) = fw.symbol(name) {
                other_lists.push((a, state));
            }
        }
        Some(Self {
            current_tcb,
            ready_lists,
            priorities,
            other_lists,
            scheduler_running: fw.symbol("xSchedulerRunning"),
            tick_count: fw.symbol("xTickCount"),
            // V11 has an array (one per core), V10 a single handle.
            idle_handle: fw
                .symbol("xIdleTaskHandles")
                .or_else(|| fw.symbol("xIdleTaskHandle")),
            cmsis_os2: fw.symbol("osKernelInitialize").is_some(),
        })
    }

    /// Read the kernel state. `mem` reads a 32-bit word (None if unmapped).
    pub fn snapshot(&self, mem: &dyn Fn(u32) -> Option<u32>) -> RtosSnapshot {
        let word = |a: u32| mem(a).unwrap_or(0);
        let byte = |a: u32| (word(a & !3) >> (8 * (a & 3))) as u8;
        let current = Some(word(self.current_tcb)).filter(|&t| t != 0);

        // Name length (configMAX_TASK_NAME_LEN) and whether pxEndOfStack
        // follows it, from the idle task: its name is "IDLE".
        let mut name_len = 16;
        let mut has_end = false;
        if let Some(idle) = self.idle_handle.map(word).filter(|&t| t != 0) {
            let name: Vec<u8> = (0..5).map(|i| byte(idle + TCB_NAME + i)).collect();
            if name == b"IDLE\0" {
                for len in [16u32, 8, 10, 12, 20, 24, 32] {
                    let end = word(idle + TCB_NAME + len.next_multiple_of(4));
                    let base = word(idle + TCB_STACK);
                    if end > base && end - base < 0x1_0000 && (end - base + 4) % 4 == 0 {
                        name_len = len;
                        has_end = true;
                        break;
                    }
                }
            }
        }

        let mut tasks = Vec::new();
        let mut seen = std::collections::BTreeSet::new();
        let mut walk = |list: u32, state: TaskState, tasks: &mut Vec<TaskInfo>| {
            let end = list + 8; // xListEnd
            let mut item = word(end + ITEM_NEXT);
            let mut guard = 0;
            while item != end && item != 0 && guard < 256 {
                guard += 1;
                let tcb = word(item + ITEM_OWNER);
                if tcb != 0 && seen.insert(tcb) {
                    tasks.push(self.task(tcb, state, current, name_len, has_end, &word, &byte));
                }
                item = word(item + ITEM_NEXT);
            }
        };
        for p in (0..self.priorities).rev() {
            walk(
                self.ready_lists + p * LIST_SIZE,
                TaskState::Ready,
                &mut tasks,
            );
        }
        for &(list, state) in &self.other_lists {
            walk(list, state, &mut tasks);
        }
        if let Some(cur) = current {
            if !seen.contains(&cur) {
                tasks.insert(
                    0,
                    self.task(
                        cur,
                        TaskState::Running,
                        current,
                        name_len,
                        has_end,
                        &word,
                        &byte,
                    ),
                );
            }
        }
        RtosSnapshot {
            kernel: "FreeRTOS",
            api: self.cmsis_os2.then_some("CMSIS-RTOS2"),
            scheduler_running: self.scheduler_running.map(word).unwrap_or(0) != 0,
            tick: self.tick_count.map(word).unwrap_or(0),
            current,
            tasks,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn task(
        &self,
        tcb: u32,
        listed: TaskState,
        current: Option<u32>,
        name_len: u32,
        has_end: bool,
        word: &dyn Fn(u32) -> u32,
        byte: &dyn Fn(u32) -> u8,
    ) -> TaskInfo {
        let name: String = (0..name_len)
            .map(|i| byte(tcb + TCB_NAME + i))
            .take_while(|&c| c != 0)
            .map(|c| {
                if c.is_ascii_graphic() || c == b' ' {
                    c as char
                } else {
                    '?'
                }
            })
            .collect();
        let state = if Some(tcb) == current {
            TaskState::Running
        } else if listed == TaskState::Suspended && word(tcb + TCB_EVENT_ITEM + ITEM_CONTAINER) != 0
        {
            // Waiting on an event without timeout: FreeRTOS keeps such
            // tasks in the suspended list but reports them as blocked.
            TaskState::Blocked
        } else {
            listed
        };
        let _ = TCB_STATE_ITEM;
        let stack_base = word(tcb + TCB_STACK);
        let stack_size = has_end.then(|| {
            let end = word(tcb + TCB_NAME + name_len.next_multiple_of(4));
            // The kernel aligns the end down to 8 bytes; sizes are almost
            // always a multiple of 8, so round back up.
            (end.wrapping_sub(stack_base) + 4).next_multiple_of(8)
        });
        let stack_free_min = (byte(stack_base) == STACK_FILL).then(|| {
            let limit = stack_size.unwrap_or(0x1_0000);
            (0..limit)
                .take_while(|&i| byte(stack_base + i) == STACK_FILL)
                .count() as u32
        });
        TaskInfo {
            tcb,
            name,
            state,
            priority: word(tcb + TCB_PRIORITY),
            stack_base,
            stack_size,
            stack_free_min,
        }
    }
}
