package fi.poma.pathfinder;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanSettings;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.net.wifi.ScanResult;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import androidx.core.content.ContextCompat;
import androidx.core.location.LocationManagerCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/** Raw Wi-Fi and BLE scanning. All position maths lives in wireless.js. */
@CapacitorPlugin(
    name = "PomaSensors",
    permissions = {
        @Permission(strings = { Manifest.permission.ACCESS_FINE_LOCATION }, alias = "location"),
        @Permission(strings = { Manifest.permission.BLUETOOTH_SCAN }, alias = "bluetooth")
    }
)
public class PomaSensorsPlugin extends Plugin {
    private final Handler main = new Handler(Looper.getMainLooper());

    private boolean has(String p) {
        return ContextCompat.checkSelfPermission(getContext(), p) == PackageManager.PERMISSION_GRANTED;
    }
    private boolean wifiPermOk() { return has(Manifest.permission.ACCESS_FINE_LOCATION); }
    private boolean blePermOk() {
        return Build.VERSION.SDK_INT >= 31 ? has(Manifest.permission.BLUETOOTH_SCAN)
                                           : has(Manifest.permission.ACCESS_FINE_LOCATION);
    }
    private WifiManager wifi() {
        return (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
    }
    private BluetoothAdapter btAdapter() {
        BluetoothManager bm = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        return bm == null ? null : bm.getAdapter();
    }

    @SuppressLint("MissingPermission")
    @PluginMethod
    public void getStatus(PluginCall call) {
        LocationManager lm = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
        BluetoothAdapter bt = btAdapter();
        JSObject ret = new JSObject();
        ret.put("sdk", Build.VERSION.SDK_INT);
        ret.put("wifiEnabled", wifi().isWifiEnabled());
        ret.put("bluetoothEnabled", bt != null && bt.isEnabled());
        ret.put("locationServicesOn", LocationManagerCompat.isLocationEnabled(lm));
        ret.put("wifiPermission", wifiPermOk());
        ret.put("blePermission", blePermOk());
        ret.put("wifiRtt", getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_WIFI_RTT));
        call.resolve(ret);
    }

    @PluginMethod
    public void requestAllPermissions(PluginCall call) {
        ArrayList<String> aliases = new ArrayList<>();
        aliases.add("location");
        if (Build.VERSION.SDK_INT >= 31) aliases.add("bluetooth");
        requestPermissionForAliases(aliases.toArray(new String[0]), call, "permissionsDone");
    }

    @PermissionCallback
    private void permissionsDone(PluginCall call) { getStatus(call); }

    @SuppressLint("MissingPermission")
    @SuppressWarnings("deprecation")
    private JSArray wifiResults() {
        JSArray arr = new JSArray();
        long nowUs = SystemClock.elapsedRealtimeNanos() / 1000;
        try {
            for (ScanResult r : wifi().getScanResults()) {
                JSObject o = new JSObject();
                o.put("bssid", r.BSSID);
                o.put("ssid", r.SSID);
                o.put("rssi", r.level);
                o.put("freq", r.frequency);
                o.put("ageMs", (nowUs - r.timestamp) / 1000);
                arr.put(o);
            }
        } catch (SecurityException ignored) { }
        return arr;
    }

    private void finishWifi(PluginCall call, AtomicBoolean done, BroadcastReceiver rec, boolean throttled) {
        if (!done.compareAndSet(false, true)) return;
        try { getContext().unregisterReceiver(rec); } catch (Exception ignored) { }
        JSObject ret = new JSObject();
        ret.put("results", wifiResults());
        ret.put("throttled", throttled);
        call.resolve(ret);
    }

    /** Android limits scans (about 4 per 2 min); when throttled, cached results are returned. */
    @SuppressWarnings("deprecation")
    @PluginMethod
    public void scanWifi(final PluginCall call) {
        if (!wifiPermOk()) { call.reject("permission_denied"); return; }
        if (!wifi().isWifiEnabled()) { call.reject("wifi_off"); return; }
        final AtomicBoolean done = new AtomicBoolean(false);
        final BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent i) { finishWifi(call, done, this, false); }
        };
        ContextCompat.registerReceiver(getContext(), receiver,
            new IntentFilter(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION), ContextCompat.RECEIVER_NOT_EXPORTED);
        boolean started = wifi().startScan();
        if (!started) finishWifi(call, done, receiver, true);
        else main.postDelayed(() -> finishWifi(call, done, receiver, true), 8000);
    }

    @SuppressLint("MissingPermission")
    @PluginMethod
    public void scanBle(final PluginCall call) {
        if (!blePermOk()) { call.reject("permission_denied"); return; }
        BluetoothAdapter adapter = btAdapter();
        if (adapter == null || !adapter.isEnabled()) { call.reject("bluetooth_off"); return; }
        final BluetoothLeScanner scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) { call.reject("bluetooth_off"); return; }
        Integer d = call.getInt("durationMs");
        long duration = d == null ? 4000 : d;
        final Map<String, JSObject> seen = new HashMap<>();
        final Map<String, int[]> sums = new HashMap<>();

        final ScanCallback cb = new ScanCallback() {
            @Override public void onScanResult(int type, android.bluetooth.le.ScanResult r) {
                ScanRecord rec = r.getScanRecord();
                String id = r.getDevice().getAddress();
                Integer tx = null;
                byte[] m = rec == null ? null : rec.getManufacturerSpecificData(0x004C); // iBeacon
                if (m != null && m.length >= 23 && m[0] == 0x02 && m[1] == 0x15) {
                    StringBuilder hex = new StringBuilder();
                    for (int k = 2; k <= 17; k++) hex.append(String.format("%02x", m[k]));
                    int major = ((m[18] & 0xFF) << 8) | (m[19] & 0xFF);
                    int minor = ((m[20] & 0xFF) << 8) | (m[21] & 0xFF);
                    id = "ibeacon:" + hex + ":" + major + ":" + minor;
                    tx = (int) m[22];
                }
                int[] s = sums.get(id);
                if (s == null) { s = new int[2]; sums.put(id, s); }
                s[0] += r.getRssi(); s[1]++;
                JSObject o = seen.get(id);
                if (o == null) { o = new JSObject(); seen.put(id, o); }
                o.put("id", id);
                if (rec != null && rec.getDeviceName() != null) o.put("name", rec.getDeviceName());
                if (tx != null) o.put("tx", tx.intValue());
            }
        };
        scanner.startScan(null, new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), cb);
        main.postDelayed(() -> {
            try { scanner.stopScan(cb); } catch (Exception ignored) { }
            JSArray arr = new JSArray();
            for (Map.Entry<String, JSObject> e : seen.entrySet()) {
                int[] s = sums.get(e.getKey());
                e.getValue().put("rssi", s[0] / s[1]);
                e.getValue().put("count", s[1]);
                arr.put(e.getValue());
            }
            JSObject ret = new JSObject();
            ret.put("results", arr);
            call.resolve(ret);
        }, duration);
    }
}
