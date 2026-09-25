package android.content;
public class Context {
    public static final int MODE_PRIVATE=0;
    public static final String ACTIVITY_SERVICE="activity";
    public static final String VIBRATOR_SERVICE="vibrator";
    public static final String CAMERA_SERVICE="camera";
    public static final int RESULT_OK=-1;
    public static final int RESULT_CANCELED=0;
    public SharedPreferences getSharedPreferences(String n,int m){return null;}
    public Object getSystemService(String n){return null;}
    public void startActivity(Intent i){}
    public String getString(int id){return "";}
    public int getColor(int id){return 0;}
    public android.content.res.Resources getResources(){return null;}
    public String getPackageName(){return "";}
    protected void onDestroy(){}
}
