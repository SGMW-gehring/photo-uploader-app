package android.animation;
public abstract class AnimatorListenerAdapter implements ValueAnimator.AnimatorListener {
    public void onAnimationStart(ValueAnimator a){}
    public void onAnimationEnd(ValueAnimator a){}
    public void onAnimationCancel(ValueAnimator a){}
    public void onAnimationRepeat(ValueAnimator a){}
}
