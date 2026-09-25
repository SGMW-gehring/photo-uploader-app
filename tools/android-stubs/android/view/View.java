package android.view;
import android.content.Context;
import android.graphics.Canvas;
public class View {
    public interface OnClickListener { void onClick(View v); }
    public interface OnTouchListener { boolean onTouch(View v, MotionEvent e); }
    public View(Context c){}
    public Context getContext(){return null;}
    public void setOnClickListener(OnClickListener l){}
    public void setOnTouchListener(OnTouchListener l){}
    public void setLayoutParams(ViewGroup.LayoutParams p){}
    public ViewGroup.LayoutParams getLayoutParams(){return null;}
    public void setAlpha(float a){}
    public void setBackgroundColor(int c){}
    public void setPadding(int l,int t,int r,int b){}
    public void setVisibility(int v){}
    public void setEnabled(boolean e){}
    public boolean isFinishing(){return false;}
    public void invalidate(){}
    public void post(Runnable r){}
    protected void onDraw(Canvas c){}
    protected void onDetachedFromWindow(){}
    protected void onLayout(boolean changed,int l,int t,int r,int b){}
    public int getWidth(){return 0;}
    public int getHeight(){return 0;}
    public int getId(){return 0;}
    public void setId(int id){}
    public android.content.res.Resources getResources(){return null;}
    public static final int VISIBLE=0, INVISIBLE=4, GONE=8;
}
