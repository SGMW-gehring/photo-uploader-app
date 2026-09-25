package android.app;
import android.content.Context;
import android.os.Bundle;
public class Activity extends android.content.Context {
    protected void onCreate(Bundle b){}
    protected void onStart(){}
    protected void onResume(){}
    protected void onPause(){}
    protected void onStop(){}
    protected void onDestroy(){}
    public void finish(){}
    public void setResult(int r){}
    public void runOnUiThread(Runnable r){}
    public void startActivity(android.content.Intent i){}
    public void startActivityForResult(android.content.Intent i,int code){}
    public android.content.Intent getIntent(){return null;}
    public void setContentView(android.view.View v){}
    public void setContentView(int id){}
    public boolean moveTaskToBack(boolean b){return true;}
    public void onBackPressed(){}
    public Context getApplicationContext(){return null;}
}
