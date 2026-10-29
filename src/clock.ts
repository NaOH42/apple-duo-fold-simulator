export interface DeviceClock {
  time: string;
  date: string;
  /** Local calendar minute, used to refresh both screen textures together. */
  key: string;
}

const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
const twoDigits = (value: number) => String(value).padStart(2, '0');

/** Read the player's local clock, including device time-zone and manual clock changes. */
export function deviceClock(date = new Date()): DeviceClock {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hour = date.getHours();
  const minute = date.getMinutes();
  return {
    time: `${hour}:${twoDigits(minute)}`,
    date: `${month}月${day}日 星期${weekdays[date.getDay()]}`,
    key: `${year}-${twoDigits(month)}-${twoDigits(day)}T${twoDigits(hour)}:${twoDigits(minute)}`,
  };
}
