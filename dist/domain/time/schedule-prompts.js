export const DEFAULT_SCHEDULE_INSTRUCTIONS='根据本轮剧情和已有日程，提取或更新有明确时间线索的日常安排与纪念日。仅依据实际发送的正文，不猜测日期，不把愿望、假设、随口提及当作明确安排。完全没有日期线索的普通待办不记录。本轮原文明示的新故事当前日期优先于已有日期基准；计划日期不当作故事当前时间。仅在故事日期足够完整、相对日期明确时换算，不补猜缺失的年月日。\n\n日常安排的日期和安排均明确时可以正式入历；日期不全、相对日期无法可靠确定、安排尚未确认时保留为候选。纪念日默认保留为候选，由用户核对后启用。周或月重复只保留原文候选，不自行转换为其他周期。\n\n辨认已有记录时使用其真实 ID。剧情明确改期、取消或完成时更新对应记录，不另建一条替代；仅名字相同无法确认同一事项时不要合并。未变化的事实不重复输出，人工保护记录不改写。不因故事日期过去而取消、完成或暂停事项；周年事项不会因一次日期经过而永久停用。';
export function assertScheduleTrackingConfig(value){
 if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).length!==2||!Array.isArray(value.categories)||new Set(value.categories).size!==value.categories.length||value.categories.some(kind=>!['schedule','anniversary'].includes(kind))||typeof value.instructions!=='string'||!value.instructions.trim()||value.instructions.length>20000)throw new Error('请填写有效的日程提取要求（最多 20000 字）并选择有效类别');
 return structuredClone(value);
}
