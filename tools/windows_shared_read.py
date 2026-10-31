import ctypes
def shared_bytes(path,limit=33554432):
 k=ctypes.WinDLL('kernel32',use_last_error=True)
 k.CreateFileW.argtypes=[ctypes.c_wchar_p,ctypes.c_ulong,ctypes.c_ulong,ctypes.c_void_p,ctypes.c_ulong,ctypes.c_ulong,ctypes.c_void_p];k.CreateFileW.restype=ctypes.c_void_p
 k.GetFileSizeEx.argtypes=[ctypes.c_void_p,ctypes.POINTER(ctypes.c_longlong)];k.ReadFile.argtypes=[ctypes.c_void_p,ctypes.c_void_p,ctypes.c_ulong,ctypes.POINTER(ctypes.c_ulong),ctypes.c_void_p];k.CloseHandle.argtypes=[ctypes.c_void_p]
 h=k.CreateFileW(str(path),0x80000000,7,None,3,0,None)
 if h in [None,ctypes.c_void_p(-1).value]:raise OSError('SHARED_READ_OPEN_FAILED',ctypes.get_last_error())
 try:
  size=ctypes.c_longlong()
  if not k.GetFileSizeEx(h,ctypes.byref(size)) or not 0<=size.value<=limit:raise OSError('SHARED_READ_SIZE_DENIED')
  out=bytearray();remaining=size.value
  while remaining:
   buf=ctypes.create_string_buffer(min(65536,remaining));n=ctypes.c_ulong()
   if not k.ReadFile(h,buf,len(buf),ctypes.byref(n),None):raise OSError('SHARED_READ_FAILED',ctypes.get_last_error())
   if n.value==0:raise OSError('SHARED_READ_TRUNCATED')
   out.extend(buf.raw[:n.value]);remaining-=n.value
  return bytes(out)
 finally:k.CloseHandle(h)
