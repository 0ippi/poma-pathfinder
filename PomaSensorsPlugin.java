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
import android.telephony.CellIdentityGsm;
import android.telephony.CellIdentityLte;
import android.telephony.CellIdentityNr;
import android.telephony.CellIdentityWcdma;
import android.telephony.CellInfo;
import android.telephony.CellInfoGsm;
import android.telephony.CellInfoLte;
import android.telephony.CellInfoNr;
import android.telephony.CellInfoWcdma;
import android.telephony.TelephonyManager;
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
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Raw radio scanning only: Wi-Fi access points, BLE devices and mobile cells.
 * It never uses GPS. All position maths lives in wireless.js.
 */
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
    private boolean locationPermOk() { return has(Manifest.permission.ACCESS_FINE_LOCATION); }
    private boolean blePermOk() {
        return Build.VERSION.SDK_INT >= 31 ? has(Manifest.permission.BLUETOOTH_SCAN) : locationPermOk();
    }
    private WifiManager wifi() {
        return (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
    }
    private BluetoothAdapter btAdapter() {
        BluetoothManager bm = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        return bm == null ? null : bm.getAdapter();
    }
    private TelephonyManager telephony() {
        return (TelephonyManager) getContext().getSystemService(Context.TELEPHONY_SERVICE);
    }

    /* ------------------------------------------------------------------ status / permissions */

    @SuppressLint("MissingPermission")
    @PluginMethod
    public void getStatus(PluginCall call) {
        LocationManager lm = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
        BluetoothAdapter bt = btAdapter();
        JSObject ret = new JSObject();
        ret.put("sdk", Build.VERSION.SDK_INT);
        ret.put("device", Build.MANUFACTURER + " " + Build.MODEL);
        ret.put("wifiEnabled", wifi().isWifiEnabled());
        ret.put("bluetoothEnabled", bt != null && bt.isEnabled());
        ret.put("locationServicesOn", lm != null && LocationManagerCompat.isLocationEnabled(lm));
        ret.put("locationPermission", locationPermOk());
        ret.put("blePermission", blePermOk());
        ret.put("hasTelephony", getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_TELEPHONY));
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

    /* ------------------------------------------------------------------ Wi-Fi */

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

    /** Android allows only ~4 scans per 2 minutes; when throttled the cached results are returned. */
    @SuppressWarnings("deprecation")
    @PluginMethod
    public void scanWifi(final PluginCall call) {
        if (!locationPermOk()) { call.reject("permission_denied"); return; }
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

    /* ------------------------------------------------------------------ BLE */

    @SuppressLint("MissingPermission")
    @PluginMethod
    public void scanBle(final PluginCall call) {
        if (!blePermOk()) { call.reject("permission_denied"); return; }
        BluetoothAdapter adapter = btAdapter();
        if (adapter == null || !adapter.isEnabled()) { call.reject("bluetooth_off"); return; }
        final BluetoothLeScanner scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) { call.reject("bluetooth_off"); return; }
        Integer d = call.getInt("durationMs");
        long duration = d == null ? 3000 : d;
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

    /* ------------------------------------------------------------------ mobile cells */

    private static final int NA = Integer.MAX_VALUE;

    private static boolean ok(int v) { return v != NA && v >= 0; }
    private static int tacOf(CellIdentityLte id) { return Build.VERSION.SDK_INT >= 24 ? id.getTac() : NA; }
    private static Integer num(String s) {
        try { return s == null ? null : Integer.valueOf(Integer.parseInt(s)); } catch (NumberFormatException e) { return null; }
    }

    /** Fills the common fields; returns null when the cell has no usable identity. */
    private JSObject cell(String type, boolean registered, String mcc, String mnc,
                          int area, long cid, int pci, int dbm) {
        Integer mccN = num(mcc), mncN = num(mnc);
        if (mccN == null || mncN == null) return null;
        JSObject o = new JSObject();
        o.put("type", type);
        o.put("registered", registered);
        o.put("mcc", mccN.intValue());
        o.put("mnc", mncN.intValue());
        if (ok(area)) o.put("area", area);
        if (cid >= 0 && cid != NA && cid != Long.MAX_VALUE) o.put("cid", cid);
        if (ok(pci)) o.put("pci", pci);
        if (dbm != NA) o.put("rssi", dbm);
        return o;
    }

    @SuppressWarnings("deprecation")
    private JSObject cellToJson(CellInfo ci) {
        boolean reg = ci.isRegistered();
        if (ci instanceof CellInfoLte) {
            CellIdentityLte id = ((CellInfoLte) ci).getCellIdentity();
            String mcc = Build.VERSION.SDK_INT >= 28 ? id.getMccString() : (ok(id.getMcc()) ? String.valueOf(id.getMcc()) : null);
            String mnc = Build.VERSION.SDK_INT >= 28 ? id.getMncString() : (ok(id.getMnc()) ? String.valueOf(id.getMnc()) : null);
            return cell("lte", reg, mcc, mnc, tacOf(id), id.getCi(), id.getPci(),
                ((CellInfoLte) ci).getCellSignalStrength().getDbm());
        }
        if (ci instanceof CellInfoGsm) {
            CellIdentityGsm id = ((CellInfoGsm) ci).getCellIdentity();
            String mcc = Build.VERSION.SDK_INT >= 28 ? id.getMccString() : (ok(id.getMcc()) ? String.valueOf(id.getMcc()) : null);
            String mnc = Build.VERSION.SDK_INT >= 28 ? id.getMncString() : (ok(id.getMnc()) ? String.valueOf(id.getMnc()) : null);
            return cell("gsm", reg, mcc, mnc, id.getLac(), id.getCid(), NA,
                ((CellInfoGsm) ci).getCellSignalStrength().getDbm());
        }
        if (ci instanceof CellInfoWcdma) {
            CellIdentityWcdma id = ((CellInfoWcdma) ci).getCellIdentity();
            String mcc = Build.VERSION.SDK_INT >= 28 ? id.getMccString() : (ok(id.getMcc()) ? String.valueOf(id.getMcc()) : null);
            String mnc = Build.VERSION.SDK_INT >= 28 ? id.getMncString() : (ok(id.getMnc()) ? String.valueOf(id.getMnc()) : null);
            return cell("wcdma", reg, mcc, mnc, id.getLac(), id.getCid(), id.getPsc(),
                ((CellInfoWcdma) ci).getCellSignalStrength().getDbm());
        }
        if (Build.VERSION.SDK_INT >= 29) return nrToJson(ci);
        return null;
    }

    @SuppressLint("NewApi")
    private JSObject nrToJson(CellInfo ci) {
        if (!(ci instanceof CellInfoNr)) return null;
        CellInfoNr nr = (CellInfoNr) ci;
        if (!(nr.getCellIdentity() instanceof CellIdentityNr)) return null;
        CellIdentityNr id = (CellIdentityNr) nr.getCellIdentity();
        return cell("nr", ci.isRegistered(), id.getMccString(), id.getMncString(),
            id.getTac(), id.getNci(), id.getPci(), nr.getCellSignalStrength().getDbm());
    }

    private JSObject cellResult(List<CellInfo> cells, boolean fresh) {
        JSArray arr = new JSArray();
        if (cells != null) {
            for (CellInfo ci : cells) {
                try {
                    JSObject o = cellToJson(ci);
                    if (o != null) arr.put(o);
                } catch (Exception ignored) { }
            }
        }
        JSObject ret = new JSObject();
        ret.put("results", arr);
        ret.put("fresh", fresh);
        return ret;
    }

    @SuppressLint("MissingPermission")
    private List<CellInfo> cachedCells(TelephonyManager tm) {
        try { return tm.getAllCellInfo(); } catch (SecurityException e) { return null; }
    }

    @SuppressLint("MissingPermission")
    @PluginMethod
    public void scanCells(final PluginCall call) {
        if (!locationPermOk()) { call.reject("permission_denied"); return; }
        final TelephonyManager tm = telephony();
        if (tm == null || !getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_TELEPHONY)) {
            call.reject("no_telephony");
            return;
        }
        if (Build.VERSION.SDK_INT < 29) {
            call.resolve(cellResult(cachedCells(tm), false));
            return;
        }
        final AtomicBoolean done = new AtomicBoolean(false);
        try {
            tm.requestCellInfoUpdate(getContext().getMainExecutor(), new TelephonyManager.CellInfoCallback() {
                @Override public void onCellInfo(List<CellInfo> cells) {
                    if (done.compareAndSet(false, true)) call.resolve(cellResult(cells, true));
                }
                @Override public void onError(int errorCode, Throwable detail) {
                    if (done.compareAndSet(false, true)) call.resolve(cellResult(cachedCells(tm), false));
                }
            });
        } catch (SecurityException e) {
            if (done.compareAndSet(false, true)) call.reject("permission_denied");
            return;
        }
        main.postDelayed(() -> {
            if (done.compareAndSet(false, true)) call.resolve(cellResult(cachedCells(tm), false));
        }, 3000);
    }
}
