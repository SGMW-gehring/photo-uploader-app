package android.widget;
import android.content.Context;
import android.view.View;
import android.view.ViewGroup;
public class FrameLayout extends ViewGroup {
    public FrameLayout(Context c){super(c);}
    public void addView(View v){}
    public void addView(View v,ViewGroup.LayoutParams p){}
    public void addView(View v,int w,int h){}
    public static class LayoutParams extends ViewGroup.LayoutParams {
        public int gravity;
        public int leftMargin, topMargin, rightMargin, bottomMargin;
        public LayoutParams(int w,int h){super(w,h);}
    }
}
