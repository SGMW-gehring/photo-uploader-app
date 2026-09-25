package androidx.camera.lifecycle;
import androidx.camera.core.Camera;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageCapture;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.Preview;
import androidx.camera.core.UseCase;
import androidx.lifecycle.LifecycleOwner;
public class ProcessCameraProvider {
    public static com.google.common.util.concurrent.ListenableFuture<ProcessCameraProvider> getInstance(android.content.Context c){return null;}
    public void unbindAll(){}
    public Camera bindToLifecycle(LifecycleOwner o,CameraSelector s,UseCase... u){return new Camera();}
    public Camera bindToLifecycle(LifecycleOwner o,CameraSelector s,Preview p,ImageCapture i){return new Camera();}
    public Camera bindToLifecycle(LifecycleOwner o,CameraSelector s,Preview p){return new Camera();}
}
