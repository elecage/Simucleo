//! Kernel-aware view of FreeRTOS: tasks, their states and stacks, read from
//! the simulated memory with the ELF's symbols (no firmware changes, like a
//! debugger's RTOS plug-in).
//!
//! Layout assumptions (FreeRTOS V10/V11, single core, no MPU wrappers):
//! `List_t` is 20 bytes (mini list end item), `ListItem_t` 20 bytes, and a
//! TCB starts with `pxTopOfStack`, `xStateListItem`, `xEventListItem`,
//! `uxPriority`, `pxStack`, `pcTaskName[...]`. The name length and the
//! optional `pxEndOfStack` are detected from the idle task's TCB.

use std::collections::HashMap;

use simucleo_elf::FirmwareImage;

const LIST_SIZE: u32 = 20;
/// Offsets inside a TCB.
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

/// Where the fields of a TCB are (byte offsets).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TcbLayout {
    event_item: u32,
    priority: u32,
    stack: u32,
    name: u32,
    name_len: u32,
    end_of_stack: Option<u32>,
    /// `ucNotifyState[0]`: tells a task waiting for a notification forever
    /// from a suspended one. Only known from debug information.
    notify_state: Option<u32>,
}

impl TcbLayout {
    /// From the DWARF description of `struct tskTaskControlBlock`.
    fn from_dwarf(members: &HashMap<String, u32>) -> Option<Self> {
        let name = *members.get("pcTaskName")?;
        // The name runs up to the next member.
        let name_len = members
            .values()
            .filter(|&&o| o > name)
            .min()
            .map_or(16, |&next| next - name);
        Some(Self {
            event_item: *members.get("xEventListItem")?,
            priority: *members.get("uxPriority")?,
            stack: *members.get("pxStack")?,
            name,
            name_len,
            end_of_stack: members.get("pxEndOfStack").copied(),
            notify_state: members.get("ucNotifyState").copied(),
        })
    }
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
    /// TCB layout from debug information, when the ELF has it.
    dwarf: Option<TcbLayout>,
}

impl FreeRtos {
    /// Find the kernel in the firmware's symbols; `elf` (the file itself)
    /// supplies the TCB layout from its debug information, if any.
    pub fn detect(fw: &FirmwareImage, elf: &[u8]) -> Option<Self> {
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
            dwarf: simucleo_elf::struct_layout(elf, "tskTaskControlBlock")
                .as_ref()
                .and_then(TcbLayout::from_dwarf),
        })
    }

    /// Without debug information: the usual layout, with the name length
    /// and `pxEndOfStack` detected from the idle task (its name is "IDLE").
    fn guess_layout(&self, word: &dyn Fn(u32) -> u32, byte: &dyn Fn(u32) -> u8) -> TcbLayout {
        let mut layout = TcbLayout {
            event_item: TCB_EVENT_ITEM,
            priority: TCB_PRIORITY,
            stack: TCB_STACK,
            name: TCB_NAME,
            name_len: 16,
            end_of_stack: None,
            notify_state: None,
        };
        if let Some(idle) = self.idle_handle.map(word).filter(|&t| t != 0) {
            let name: Vec<u8> = (0..5).map(|i| byte(idle + TCB_NAME + i)).collect();
            if name == b"IDLE\0" {
                for len in [16u32, 8, 10, 12, 20, 24, 32] {
                    let off = TCB_NAME + len.next_multiple_of(4);
                    let end = word(idle + off);
                    let base = word(idle + TCB_STACK);
                    if end > base && end - base < 0x1_0000 {
                        layout.name_len = len;
                        layout.end_of_stack = Some(off);
                        break;
                    }
                }
            }
        }
        layout
    }

    /// Read the kernel state. `mem` reads a 32-bit word (None if unmapped).
    pub fn snapshot(&self, mem: &dyn Fn(u32) -> Option<u32>) -> RtosSnapshot {
        let word = |a: u32| mem(a).unwrap_or(0);
        let byte = |a: u32| (word(a & !3) >> (8 * (a & 3))) as u8;
        let current = Some(word(self.current_tcb)).filter(|&t| t != 0);
        let layout = self
            .dwarf
            .unwrap_or_else(|| self.guess_layout(&word, &byte));

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
                    tasks.push(task(tcb, state, current, &layout, &word, &byte));
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
                let t = task(cur, TaskState::Running, current, &layout, &word, &byte);
                tasks.insert(0, t);
            }
        }
        // Stack filling (tskSTACK_FILL_BYTE) is a kernel-wide setting: if any
        // stack carries the pattern, they all do, and a stack without any
        // fill byte left is exhausted (0 free), not unknown.
        if !tasks.iter().any(|t| t.stack_free_min.unwrap_or(0) > 0) {
            for t in &mut tasks {
                t.stack_free_min = None;
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
}

/// `taskWAITING_NOTIFICATION` in `ucNotifyState`.
const WAITING_NOTIFICATION: u8 = 1;

fn task(
    tcb: u32,
    listed: TaskState,
    current: Option<u32>,
    l: &TcbLayout,
    word: &dyn Fn(u32) -> u32,
    byte: &dyn Fn(u32) -> u8,
) -> TaskInfo {
    let name: String = (0..l.name_len)
        .map(|i| byte(tcb + l.name + i))
        .take_while(|&c| c != 0)
        .map(|c| {
            if c.is_ascii_graphic() || c == b' ' {
                c as char
            } else {
                '?'
            }
        })
        .collect();
    // In the suspended list, a task that waits without timeout — on an
    // event (queue, semaphore) or for a notification (CMSIS thread flags) —
    // is reported as blocked, as eTaskGetState does.
    let waits_forever = word(tcb + l.event_item + ITEM_CONTAINER) != 0
        || l.notify_state
            .is_some_and(|o| byte(tcb + o) == WAITING_NOTIFICATION);
    let state = if Some(tcb) == current {
        TaskState::Running
    } else if listed == TaskState::Suspended && waits_forever {
        TaskState::Blocked
    } else {
        listed
    };
    let stack_base = word(tcb + l.stack);
    let stack_size = l.end_of_stack.map(|o| {
        let end = word(tcb + o);
        // The kernel aligns the end down to 8 bytes; sizes are almost
        // always a multiple of 8, so round back up.
        (end.wrapping_sub(stack_base) + 4).next_multiple_of(8)
    });
    let limit = stack_size.unwrap_or(0x1_0000);
    let filled = (0..limit)
        .take_while(|&i| byte(stack_base + i) == STACK_FILL)
        .count() as u32;
    TaskInfo {
        tcb,
        name,
        state,
        priority: word(tcb + l.priority),
        stack_base,
        stack_size,
        stack_free_min: Some(filled),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fake memory with one suspended list holding two tasks: one
    /// explicitly suspended, one waiting forever for a notification.
    #[test]
    fn notification_waits_are_blocked_and_exhausted_stacks_report_zero() {
        let layout = TcbLayout {
            event_item: 24,
            priority: 44,
            stack: 48,
            name: 52,
            name_len: 16,
            end_of_stack: Some(68),
            notify_state: Some(100),
        };
        let mut mem: HashMap<u32, u32> = HashMap::new();
        let mut put = |a: u32, v: u32| {
            mem.insert(a, v);
        };
        // Task A (0x1000): suspended, stack 0x3000..0x3100 untouched.
        // Task B (0x2000): waiting for a notification, stack fully used.
        for (tcb, stack, notify, fill) in [(0x1000, 0x3000, 0u32, true), (0x2000, 0x4000, 1, false)]
        {
            put(tcb + 48, stack);
            put(tcb + 68, stack + 0xF8);
            put(tcb + 52, u32::from_le_bytes(*b"T\0\0\0"));
            put(tcb + 100, notify);
            for i in (0..0x100).step_by(4) {
                put(stack + i, if fill { 0xA5A5_A5A5 } else { 0x1234_5678 });
            }
        }
        let fw = FreeRtos {
            current_tcb: 0x10,
            ready_lists: 0x100,
            priorities: 1,
            other_lists: vec![(0x200, TaskState::Suspended)],
            scheduler_running: None,
            tick_count: None,
            idle_handle: None,
            cmsis_os2: false,
            dwarf: Some(layout),
        };
        // Empty ready list; suspended list 0x200 → item 0x1004 → item 0x2004.
        put(0x100 + 8 + 4, 0x100 + 8);
        put(0x200 + 8 + 4, 0x1004);
        put(0x1004 + 4, 0x2004);
        put(0x1004 + 12, 0x1000);
        put(0x2004 + 4, 0x200 + 8);
        put(0x2004 + 12, 0x2000);
        let snap = fw.snapshot(&|a| mem.get(&a).copied().or(Some(0)));
        assert_eq!(snap.tasks.len(), 2);
        assert_eq!(snap.tasks[0].state, TaskState::Suspended);
        assert_eq!(snap.tasks[1].state, TaskState::Blocked);
        assert_eq!(snap.tasks[0].stack_size, Some(0x100));
        assert_eq!(snap.tasks[0].stack_free_min, Some(0x100));
        assert_eq!(
            snap.tasks[1].stack_free_min,
            Some(0),
            "exhausted, not unknown"
        );
    }
}
