package android.content;

import android.net.Uri;

public class Intent {
    public static final String ACTION_VIEW = "android.intent.action.VIEW";
    public static final int FLAG_ACTIVITY_NEW_TASK = 0x10000000;
    public static final int FLAG_GRANT_READ_URI_PERMISSION = 0x1;
    public Intent() {}
    public Intent(String action) {}
    public Intent(String action, Uri uri) {}
    public Intent(Context c, Class<?> cls) {}
    public String getStringExtra(String k) { return null; }
    public long getLongExtra(String k, long def) { return def; }
    public Intent putExtra(String k, String v) { return this; }
    public String getAction() { return null; }
    public Intent setDataAndType(Uri u, String t) { return this; }
    public Intent addFlags(int f) { return this; }
}
