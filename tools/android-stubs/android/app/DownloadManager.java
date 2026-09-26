package android.app;
import android.net.Uri;
import android.content.Context;
public class DownloadManager {
    public static final String ACTION_DOWNLOAD_COMPLETE = "android.intent.action.DOWNLOAD_COMPLETE";
    public static final String EXTRA_DOWNLOAD_ID = "extra_download_id";
    public long enqueue(Request r) { return 0L; }
    public static class Request {
        public static final int VISIBILITY_VISIBLE = 0;
        public Request(Uri u) {}
        public Request setTitle(CharSequence t) { return this; }
        public Request setDescription(CharSequence d) { return this; }
        public Request setNotificationVisibility(int v) { return this; }
        public Request setMimeType(String m) { return this; }
        public Request setDestinationInExternalFilesDir(Context c, String dir, String name) { return this; }
    }
}
