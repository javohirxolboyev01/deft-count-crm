import { useEffect, useState } from 'react';

/** Qiymat `ms` davomida o'zgarmay tursa qaytadi: qidiruv har harfda serverga so'rov yubormasin */
export function useDebounced<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}
