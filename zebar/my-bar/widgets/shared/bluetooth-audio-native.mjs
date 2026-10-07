// Windows Core Audio topology + SDK KSPROPSETID_BtAudio one-shot controls.
// Unlike BluetoothSetServiceState, these request an actual audio connection.
export const bluetoothAudioSource = `
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class AudioEnumeratorClass {}
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface AudioEnumerator {
  void EnumAudioEndpoints(int flow, uint states, out AudioCollection devices);
  void GetDefaultAudioEndpoint(int flow, int role, out AudioDevice device);
  void GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out AudioDevice device);
}
[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface AudioCollection { void GetCount(out uint count); void Item(uint index, out AudioDevice device); }
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface AudioDevice {
  [PreserveSig] int Activate(ref Guid iid, uint context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object result);
  void OpenPropertyStore(uint access, out IntPtr store);
  void GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  void GetState(out uint state);
}
[ComImport, Guid("2A07407E-6497-4A18-9787-32F79BD0D98F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface AudioTopology { void GetConnectorCount(out uint count); void GetConnector(uint index, out AudioConnector connector); }
[ComImport, Guid("9C2C4058-23F5-41DE-877A-DF3AF236A09E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface AudioConnector {
  void GetType(out int type); void GetDataFlow(out int flow); void ConnectTo(AudioConnector other);
  void Disconnect(); void IsConnected([MarshalAs(UnmanagedType.Bool)] out bool connected);
  void GetConnectedTo(out AudioConnector other);
  void GetConnectorIdConnectedTo([MarshalAs(UnmanagedType.LPWStr)] out string id);
  void GetDeviceIdConnectedTo([MarshalAs(UnmanagedType.LPWStr)] out string id);
}
[ComImport, Guid("28F54685-06FD-11D2-B27A-00A0C9223196"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface AudioKsControl {
  [PreserveSig] int KsProperty(ref AudioBtProperty property, uint propertySize, IntPtr data, uint dataSize, out uint returned);
}
[StructLayout(LayoutKind.Sequential)] struct AudioBtProperty { public Guid set; public uint id, flags; }
public static class BluetoothAudio {
  static void Release(object value) { if (value != null && Marshal.IsComObject(value)) Marshal.ReleaseComObject(value); }
  // The hardware topology IDs contain the exact Bluetooth address. Never match a
  // friendly name: duplicate names must not reconnect another headset.
  static Dictionary<string, uint> Endpoints(ulong address, bool describe) {
    var result = new Dictionary<string, uint>(StringComparer.OrdinalIgnoreCase);
    AudioEnumerator enumerator = null; AudioCollection collection = null;
    try {
      enumerator = (AudioEnumerator)new AudioEnumeratorClass();
      enumerator.EnumAudioEndpoints(0, 15, out collection);
      uint count; collection.GetCount(out count);
      for (uint i = 0; i < count; i++) {
        AudioDevice device = null; object topologyObject = null;
        try {
          collection.Item(i, out device);
          uint state; device.GetState(out state);
          Guid iid = typeof(AudioTopology).GUID;
          if (device.Activate(ref iid, 23, IntPtr.Zero, out topologyObject) < 0) continue;
          var topology = (AudioTopology)topologyObject;
          uint connectors; topology.GetConnectorCount(out connectors);
          for (uint c = 0; c < connectors; c++) {
            AudioConnector connector = null;
            try {
              topology.GetConnector(c, out connector);
              string id; connector.GetDeviceIdConnectedTo(out id);
              if (id.IndexOf("bth", StringComparison.OrdinalIgnoreCase) < 0) continue;
              if (describe) Console.WriteLine(id + " state=" + state);
              if (id.IndexOf(address.ToString("x12"), StringComparison.OrdinalIgnoreCase) >= 0) {
                uint previous;
                // Old and re-paired endpoints can share a hardware filter ID.
                // Preserve any active endpoint instead of letting a stale one win.
                result[id] = result.TryGetValue(id, out previous) && previous == 1 ? previous : state;
              }
            } catch (COMException) { } finally { Release(connector); }
          }
        } catch (COMException) { } finally { Release(topologyObject); Release(device); }
      }
    } finally { Release(collection); Release(enumerator); }
    return result;
  }
  public static void Describe() { Endpoints(0, true); }
  public static bool HasEndpoint(ulong address) { return Endpoints(address, false).Count > 0; }
  public static bool? ConnectionStatus(ulong address) {
    var endpoints = Endpoints(address, false);
    return endpoints.Count == 0 ? (bool?)null : endpoints.Values.Any(state => state == 1);
  }
  public static bool IsConnected(ulong address) { return ConnectionStatus(address) == true; }
  public static async Task<bool> Request(ulong address, bool connect) {
    var endpoints = Endpoints(address, false);
    if (endpoints.Count == 0 || endpoints.Values.All(state => state == 4)) return false;
    if (connect && endpoints.Values.Any(state => state == 1)) return true;
    AudioEnumerator enumerator = null;
    int accepted = 0; int lastError = 0;
    try {
      enumerator = (AudioEnumerator)new AudioEnumeratorClass();
      foreach (var id in endpoints.Keys) {
        AudioDevice device = null; object control = null;
        try {
          enumerator.GetDevice(id, out device);
          Guid iid = typeof(AudioKsControl).GUID;
          int hr = device.Activate(ref iid, 23, IntPtr.Zero, out control);
          if (hr < 0) { lastError = hr; continue; }
          var property = new AudioBtProperty { set = new Guid("7FA06C40-B8F6-4C7E-8556-E8C33A12E54D"), id = connect ? 0u : 1u, flags = 1 };
          uint returned;
          hr = ((AudioKsControl)control).KsProperty(ref property, (uint)Marshal.SizeOf(typeof(AudioBtProperty)), IntPtr.Zero, 0, out returned);
          if (hr >= 0) accepted++; else lastError = hr;
        } finally { Release(control); Release(device); }
      }
    } finally { Release(enumerator); }
    if (accepted == 0) { Marshal.ThrowExceptionForHR(lastError); throw new Exception("Windows rejected the Bluetooth audio request."); }
    // An accepted driver request is not proof of a connection. Verify the endpoint.
    for (int i = 0; i < 30; i++) {
      if (IsConnected(address) == connect) return true;
      await Task.Delay(500);
    }
    throw new TimeoutException(connect ? "Windows could not connect the Bluetooth audio device. Make sure it is awake and not connected to another phone or computer." : "Windows did not disconnect the Bluetooth audio device.");
  }
}
`;
